import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendSession, PromptAttachment } from "../backend/types.ts";
import {
  isAttachmentMediaType,
  mediaTypeOf,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BASE64_BYTES,
  type IncomingAttachment,
} from "../protocol/attachments.ts";
import type { Command, SendWhen, SessionStatus, SessionSummary } from "../protocol/commands.ts";
import type {
  AgentEvent,
  BackendEvent,
  Capabilities,
  EffortLevel,
  LoggedEvent,
  Skill,
  Spend,
} from "../protocol/events.ts";
import type { Branch } from "../protocol/git.ts";
// `switchBranch` is aliased because this class has a method of that name: the method is the
// Session Host's refusal-and-record wrapper, and the import is the git invocation it wraps.
import {
  createWorktree,
  head,
  isClean,
  isRepository,
  removeWorktree,
  switchBranch as gitSwitchBranch,
} from "./git.ts";
import { SessionLog } from "./log.ts";
import type { SessionMeta, TranscriptStore } from "./store.ts";

/**
 * A command the Session Host will not carry out in the state the thing is in — a turn in flight, a
 * Scope that is not a repository, a checkout git itself refused.
 *
 * Named for its subject the way `ConfigError` is, and its message written to be read by whoever
 * sent the command. That is the whole distinction it exists to draw: a refusal is the caller's to
 * fix and is safe to pass back, while anything else is ours and becomes a 500.
 */
export class CommandRefused extends Error {}

/** One message waiting out a turn: what the human typed, and the Attachments already written for it. */
type QueuedMessage = { text: string; attachments: string[] };

type SessionRecord = {
  id: string;
  scope: string;
  backendName: string;
  log: SessionLog;
  session: BackendSession | undefined;
  /**
   * The revive in flight, held so concurrent callers join it instead of starting a second one.
   * `session` alone cannot guard that: it is only assigned after `startBackendSession` awaits, so
   * two sends arriving while it is undefined would both pass the check and both spawn a backend —
   * leaving one orphaned process still emitting into this transcript, and splitting the two
   * messages across two Backend Sessions.
   */
  reviving: Promise<void> | undefined;
  status: SessionStatus;
  /**
   * Set by the host the moment it dispatches, not when the backend reports `turn_started`. A
   * backend may take a tick to acknowledge, and in that window a second `after_turn` send would
   * otherwise see an idle session and jump the queue.
   */
  turnInFlight: boolean;
  /**
   * Events an adapter emits while its Backend Session is still being created, held back so the
   * transcript opens with session_started (or revived) rather than with whatever the adapter
   * announced on its way up — the model in force, its capabilities.
   */
  buffered: BackendEvent[] | undefined;
  /**
   * The Steering Queue (ADR 0002). Holds Attachment *ids* rather than bytes: they are written to
   * disk when the send arrives, not when it dispatches, so a message that waits out a long turn is
   * already durable and the queue stays the small thing it was.
   */
  queue: QueuedMessage[];
  title: string;
  /**
   * The branch the Scope was on when last looked at, or undefined when it is not a repository.
   *
   * Held rather than asked for, because `list()` is synchronous and runs on every `GET
   * /api/sessions` — asking git there would be one subprocess per session per poll.
   */
  branch: Branch | undefined;
  /**
   * Bumped every time someone sets out to learn the branch, so a slower answer cannot overwrite a
   * newer one.
   *
   * `refreshBranch` is deliberately `void`ed at the end of a turn, so two can be in flight at once
   * — and they can resolve out of order, which without this leaves the older reading in place for
   * good: a switch that raced a turn ending reported the branch it had *left*, until the next turn
   * happened to correct it.
   */
  branchGeneration: number;
  /** Set when this Scope is a worktree this host made, and so may remove again. */
  worktree: { path: string; repo: string; branch: string } | undefined;
  /**
   * A line held back to ride along with the next message, telling the model the branch moved under
   * it. See `switchBranch` for why it cannot go through the Steering Queue.
   */
  pendingBranchNote: string | undefined;
  capabilities: Capabilities | undefined;
  /**
   * Everything this Agent Session has spent, carried across Backend Sessions.
   *
   * Held on the record and restored from the transcript on load, because a backend counts only its
   * own run: a Revive opens a new one whose counters start at zero, and the meter would drop back
   * to that — the bill appearing to reset itself.
   */
  spend: Spend | undefined;
  resumeToken: string | undefined;
  modelId: string | undefined;
  effort: EffortLevel | undefined;
  createdAt: string;
  updatedAt: string;
};

export type SessionHostOptions = {
  store?: TranscriptStore;
  /**
   * How long a Settled Agent Session survives before it is reaped, in milliseconds. `"never"`
   * disables reaping; omitted means the same, so a host built without a retention policy never
   * deletes anything (ADR 0006).
   *
   * A function is read at each sweep rather than copied in once, which is how an edit to the
   * Settings applies to a daemon that has been up for a week. The daemon passes `ConfigStore`'s
   * `retention` for exactly that; a literal is the convenience the tests use.
   */
  retention?: number | "never" | (() => number | "never");
};

/** Owns every Agent Session, and the Steering Queue that sits above all backends (ADR 0002). */
export class SessionHost {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly backends = new Map<string, AgentBackend>();
  private readonly store: TranscriptStore | undefined;
  private readonly retention: number | "never" | (() => number | "never");
  private readonly closedListeners = new Set<(sessionId: string) => void>();
  private readonly keptListeners = new Set<
    (kept: { path: string; branch: string; reason: string }) => void
  >();

  constructor(options: SessionHostOptions = {}) {
    this.store = options.store;
    this.retention = options.retention ?? "never";
  }

  /**
   * Notified when an Agent Session stops being something its owner is working in — Settled, Ended
   * or Reaped. Dormant is deliberately not one of these: it says the Backend Session went away, not
   * that the reader did.
   *
   * An observer rather than a direct call into the Shells, so the host stays ignorant that Shells
   * exist. It owns Agent Sessions; what else hangs off one is not its business.
   */
  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  private announceClosed(sessionId: string): void {
    for (const listener of this.closedListeners) listener(sessionId);
  }

  /**
   * Notified when a reap left a worktree on disk rather than removing it.
   *
   * Only a clean worktree is removed: a branch ref always survives a reap, so no commit is ever
   * lost, but uncommitted and untracked work would be — and deleting that on a retention timer,
   * from a sweep nobody is watching, is a second destructive act ADR 0006 does not license.
   *
   * An observer rather than a log call, for the reason `onSessionClosed` is one: the host owns
   * Agent Sessions, not the daemon's stderr.
   */
  onWorktreeKept(listener: (kept: { path: string; branch: string; reason: string }) => void): () => void {
    this.keptListeners.add(listener);
    return () => this.keptListeners.delete(listener);
  }

  registerBackend(backend: AgentBackend): void {
    this.backends.set(backend.name, backend);
  }

  backendNames(): string[] {
    return [...this.backends.keys()];
  }

  logFor(sessionId: string): SessionLog {
    return this.record(sessionId).log;
  }

  statusOf(sessionId: string): SessionStatus {
    return this.record(sessionId).status;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((record) => ({
        id: record.id,
        scope: record.scope,
        backend: record.backendName,
        status: record.status,
        title: record.title,
        updatedAt: record.updatedAt,
        lastSeq: record.log.lastSeq,
        ...(record.capabilities ? { capabilities: record.capabilities } : {}),
        ...(record.branch ? { branch: record.branch } : {}),
        ...(record.worktree ? { worktree: true as const } : {}),
      }))
      // Settled Agent Sessions sink to the bottom: they are the ones their owner is done with, and
      // they would otherwise sort to the top, since settling is itself the most recent activity.
      .sort((left, right) => {
        const settled = Number(left.status === "settled") - Number(right.status === "settled");
        return settled !== 0 ? settled : right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  /**
   * Load previously persisted Agent Sessions as Dormant (ADR 0003): transcripts readable, nothing
   * running, no money spent until someone asks.
   */
  async load(): Promise<void> {
    if (!this.store) return;
    for (const id of await this.store.listSessionIds()) {
      const meta = this.store.readMeta(id);
      if (!meta || this.sessions.has(id)) continue;

      const entries = this.store.readEntries(id);
      const record: SessionRecord = {
        id: meta.id,
        scope: meta.scope,
        backendName: meta.backend,
        log: this.newLog(meta.id, entries),
        session: undefined,
        reviving: undefined,
        status: meta.status === "ended" || meta.status === "settled" ? meta.status : "dormant",
        turnInFlight: false,
        buffered: undefined,
        queue: [],
        title: meta.title,
        // Recovered from the transcript rather than by asking git, for the reason capabilities are:
        // a daemon holding fifty Agent Sessions would otherwise spawn fifty processes on the way up,
        // to answer a question the next Revive or turn re-asks anyway.
        branch: branchFrom(entries),
        branchGeneration: 0,
        worktree: meta.worktree,
        pendingBranchNote: undefined,
        capabilities: capabilitiesFrom(entries),
        spend: spendFrom(entries),
        resumeToken: meta.resumeToken,
        modelId: meta.modelId,
        effort: meta.effort,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      };
      this.sessions.set(id, record);
      this.closeTornTurn(record, entries);
      // Dormancy has to be visible to a client reducing the transcript, or a session with nothing
      // running still looks ready to type at. A clean shutdown already recorded it.
      if (record.status === "dormant" && lastEventType(record.log.since(0)) !== "session_dormant") {
        record.log.append({ type: "session_dormant", reason: "host restarted" });
      }
      this.persist(record);
    }
    await this.reap();
  }

  async create(options: {
    scope: string;
    backend: string;
    modelId?: string;
    effort?: EffortLevel;
    /** Cut a worktree from `scope` and bind the Agent Session to that instead. */
    worktree?: { from: string; branch?: string };
  }): Promise<string> {
    const backend = this.backendFor(options.backend);
    const worktree = options.worktree ? await this.cutWorktree(options.scope, options.worktree) : undefined;
    // The Scope from here down, and for this Agent Session's whole life. Resolved before any record
    // exists so that a `worktree add` which failed leaves nothing persisted pointing at a directory
    // that is not there.
    const scope = worktree?.path ?? options.scope;
    const id = randomUUID();
    const now = new Date().toISOString();

    const record: SessionRecord = {
      id,
      scope,
      backendName: backend.name,
      log: this.newLog(id),
      session: undefined,
      reviving: undefined,
      status: "idle",
      turnInFlight: false,
      buffered: undefined,
      queue: [],
      title: scope,
      branch: undefined,
      branchGeneration: 0,
      worktree,
      pendingBranchNote: undefined,
      capabilities: undefined,
      spend: undefined,
      resumeToken: undefined,
      modelId: options.modelId,
      effort: options.effort,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, record);
    this.persist(record);

    record.buffered = [];
    const session = await this.startBackendSession(record);
    record.log.append({
      type: "session_started",
      backend: backend.name,
      scope,
      capabilities: session.capabilities,
      ...(worktree === undefined ? {} : { worktree: true as const }),
    });
    this.flushBuffered(record);
    // After session_started, never before: the transcript has to open with it (see `buffered`).
    await this.refreshBranch(record);
    return id;
  }

  /**
   * Create the worktree a `create` asked for.
   *
   * Throws rather than returning a failure, because its caller has someone waiting on a session id
   * and there is nothing partial to hand back: no Agent Session is created at all.
   */
  private async cutWorktree(
    repo: string,
    options: { from: string; branch?: string },
  ): Promise<{ path: string; repo: string; branch: string }> {
    // A host with no state root has nowhere to put a worktree. Said plainly rather than left to
    // fail as an undefined path, the way an unavailable pty is reported.
    if (!this.store) throw new CommandRefused("This Session Host keeps no state, so it cannot make a worktree");
    if (!isRepository(repo)) throw new CommandRefused(`${repo} is not a git repository`);

    const created = await createWorktree({
      repo,
      from: options.from,
      under: this.store.worktreesRoot(),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
    });
    if (!created.ok) throw new CommandRefused(created.failure.message);
    return { path: created.value.path, repo, branch: created.value.branch };
  }

  /** Attach a fresh Backend Session to a Dormant Agent Session, continuing the same transcript. */
  async revive(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    if (record.session) return;
    if (record.status === "ended") throw new Error(`Session ${sessionId} has ended`);
    if (record.reviving) return await record.reviving;

    const reviving = this.reviveOnce(record);
    record.reviving = reviving;
    try {
      await reviving;
    } finally {
      // Cleared even on failure, so a backend that would not start is retried by the next send.
      record.reviving = undefined;
    }
  }

  private async reviveOnce(record: SessionRecord): Promise<void> {
    const fromSeq = record.log.lastSeq;
    record.buffered = [];
    await this.startBackendSession(record);
    record.status = "idle";
    record.log.append({ type: "revived", fromSeq });
    this.flushBuffered(record);
    // A Dormant Agent Session may have sat for a week while its Scope was moved by hand.
    await this.refreshBranch(record);
  }

  /**
   * `when` is required rather than defaulted. A default of "now" would hand the next caller the one
   * value that can bypass the Steering Queue, and "after_turn" already means "queue if busy, else
   * dispatch now" — so there is no sensible default to pick. It matches `Command` either way.
   */
  async send(sessionId: string, text: string, when: SendWhen, attachments?: IncomingAttachment[]): Promise<void> {
    const record = this.record(sessionId);
    // ADR 0003: the first message revives a Dormant session, so resuming work is one action.
    if (!record.session) await this.revive(sessionId);

    // Checked before anything is written, so a refused send leaves no bytes behind.
    this.refuseUnservableAttachments(record, attachments);
    const ids = (attachments ?? []).map((attachment) =>
      this.storeOrThrow().writeAttachment(record.id, attachment.mediaType, attachment.data),
    );

    if (when === "after_turn" && record.turnInFlight) {
      record.queue.push({ text, attachments: ids });
      record.log.append({ type: "queue_changed", pending: pendingTexts(record.queue) });
      this.touch(record);
      return;
    }
    await this.dispatch(record, { text, attachments: ids });
  }

  /**
   * Whether this send's Attachments can be carried at all, refused before any are written down.
   *
   * Strict about what it *knows* is wrong and lenient about what it cannot know. The count, the
   * media type and the size are facts about the request, so a client offering one this cannot use is
   * refused — the rule the Settings already follow. Whether the model accepts an image is a fact
   * about the backend, and the host cannot always name the model in force: `record.modelId` is
   * absent whenever nobody overrode the default, which is the common case. So an unidentifiable
   * model is allowed through rather than blocking every default-model session. The positive check
   * belongs to the client, which reduces `model_changed` and therefore always knows.
   */
  private refuseUnservableAttachments(record: SessionRecord, attachments?: IncomingAttachment[]): void {
    if (!attachments?.length) return;

    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new CommandRefused(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments may be sent with one message`);
    }
    for (const attachment of attachments) {
      if (!isAttachmentMediaType(attachment.mediaType)) {
        throw new CommandRefused(`${attachment.mediaType} is not an attachable media type`);
      }
      if (attachment.data.length > MAX_ATTACHMENT_BASE64_BYTES) {
        throw new CommandRefused(`An attachment may not exceed ${MAX_ATTACHMENT_BASE64_BYTES} base64 bytes`);
      }
    }

    const model = record.session?.capabilities.models.find((candidate) => candidate.id === record.modelId);
    if (model && !model.acceptsImages) {
      throw new CommandRefused(`${model.label ?? model.id} cannot be shown an attachment`);
    }
  }

  private storeOrThrow(): TranscriptStore {
    if (!this.store) throw new CommandRefused("This Session Host keeps no state, so it cannot hold an attachment");
    return this.store;
  }

  async abort(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    // Aborting means stop, not stop-then-continue: queued follow-ups go too.
    if (record.queue.length > 0) {
      record.queue.length = 0;
      record.log.append({ type: "queue_changed", pending: [] });
    }
    await record.session?.abort();
    this.touch(record);
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const record = this.record(sessionId);
    await record.session?.setModel(modelId);
    record.modelId = modelId;
    this.touch(record);
  }

  async setEffort(sessionId: string, effort: EffortLevel): Promise<void> {
    const record = this.record(sessionId);
    await record.session?.setEffort(effort);
    // Remembered as asked for, not as clamped: a Revive onto a model that can serve it should.
    record.effort = effort;
    this.touch(record);
  }

  /**
   * Compact this Agent Session's Conversation Context now.
   *
   * **A Dormant or Settled session Revives first**, the way `send` does (ADR 0003: resuming work is
   * one action). This used to refuse, on the reasoning that a Revive rebuilds a Conversation Context
   * only to summarise what it just rebuilt. That was simply wrong — a Revive *restores* the
   * conversation from its resume token, it does not summarise it — and the case for allowing it is
   * a good one: a session parked at 90% occupancy is exactly the one worth compacting, and before
   * resuming is the best moment, because nothing is waiting on the turn it makes room for.
   *
   * Two refusals are left, and each is a state where compacting would be a lie rather than a
   * failure.
   *
   * **A turn in flight.** The backend is mid-conversation and would be summarising a context it is
   * still writing to. Queueing it instead was rejected: `abort` discards the queue wholesale, so a
   * compaction would vanish with a cancelled turn and nobody would be told which of the two they
   * had lost. This now also refuses a *second* compaction, because a compaction is a turn.
   *
   * **A backend that cannot.** Checked on `capabilities.compaction` rather than on whether the
   * method exists, so an adapter cannot half-declare itself — the flag is what clients hide the
   * control on, and the two must agree.
   *
   * **The session is occupied for the duration**, exactly as `dispatch` occupies it. A compaction
   * spends money and holds the backend for minutes, and while it did not say so the Steering Queue
   * believed the session idle — so a message typed during one was pushed into the backend's inbox
   * ahead of the compaction instead of queueing behind it, and a second `/compact` sailed past the
   * refusal above. `turn_ended` from the adapter releases it and drains the queue, the same path
   * every other turn takes.
   *
   * No `user_message` is written. Compaction is not something anyone said, and the turn it opens is
   * the backend's own work; what a reader sees is the `compacted` the adapter emits when it lands.
   */
  async compact(sessionId: string, instructions?: string): Promise<void> {
    const record = this.record(sessionId);
    // Refused rather than left to `revive`'s own throw, which would reach the client as a 500 for
    // something it should be told plainly.
    if (record.status === "ended") {
      throw new CommandRefused(`Agent Session ${sessionId} has Ended; it has no Conversation Context`);
    }
    if (!record.session) await this.revive(sessionId);

    const session = record.session;
    if (!session) {
      throw new CommandRefused(`Agent Session ${sessionId} has no Backend Session to compact`);
    }
    if (record.turnInFlight) {
      throw new CommandRefused(
        `Agent Session ${sessionId} is running; abort the turn or wait for it to end before compacting`,
      );
    }
    if (!session.capabilities.compaction || !session.compact) {
      throw new CommandRefused(`${record.backendName} cannot compact a Conversation Context`);
    }

    // Set here rather than left to the adapter's `turn_started`, because that is how `dispatch`
    // occupies a session too: the host's own flag is what `send` consults, and it must be true
    // before this returns or the very next request races it.
    record.turnInFlight = true;
    record.status = "running";
    await session.compact(instructions);
    this.touch(record);
  }

  /**
   * The Skills this Agent Session can be sent.
   *
   * Answers with an empty list in every case it cannot answer properly — no Backend Session, an
   * adapter with no notion of Skills, a backend that threw while reading its own disk. This is the
   * opposite of `compact`'s three refusals, and deliberately: a refusal is right for an act with
   * consequences and wrong for a menu. Opening one on a Dormant session must not Revive it, and must
   * not put a red toast in front of someone who pressed `/` — an empty menu says "nothing to offer
   * here" perfectly well.
   *
   * Nothing is written down, and `touch` is not called: reading a menu is not activity on an Agent
   * Session, and letting it postpone a Reap would mean an idle browser tab kept sessions alive.
   */
  async listSkills(sessionId: string): Promise<Skill[]> {
    const session = this.record(sessionId).session;
    if (!session?.skills) return [];
    try {
      return await session.skills();
    } catch {
      return [];
    }
  }

  /**
   * Move this Agent Session's Scope to another branch.
   *
   * Refused while running, and running is the only status where it has to be: git would change
   * files underneath a turn that is reading them, and the model has no way to be told mid-turn.
   * Idle, Dormant and Settled all have nothing in flight to disturb, so git is asked and whatever
   * it says is what the caller hears — git already refuses a checkout that would clobber a modified
   * file, and reimplementing that judgement here would block switches engineers make by hand.
   *
   * The refusal lives here rather than in the request handler because `execute` is not the only
   * door — the one-shot CLI and the tests call this directly — and because only the host holds
   * `status` without a gap between reading it and acting on it.
   */
  async switchBranch(sessionId: string, branch: string): Promise<Branch> {
    const record = this.record(sessionId);
    if (record.status === "running") {
      throw new CommandRefused(
        `Agent Session ${sessionId} is running; abort the turn or wait for it to end before switching branch`,
      );
    }
    if (!isRepository(record.scope)) {
      throw new CommandRefused(`${record.scope} is not a git repository`);
    }

    const switched = await gitSwitchBranch(record.scope, branch);
    if (!switched.ok) throw new CommandRefused(switched.failure.message);

    this.announceBranch(record, switched.value);
    /*
     * Held for the next message rather than sent now, and this is not a stylistic choice — the
     * Steering Queue cannot carry it.
     *
     * `send(…, "after_turn")` only queues while a turn is in flight, and a switch is permitted only
     * when one is *not*, so routing this through `send` would dispatch it immediately as its own
     * turn: an agent reply nobody asked for, spending tokens. Pushing it onto `queue` instead
     * strands it, because `drain` runs only when a turn ends and an idle session has no turn to
     * end — so it would arrive *after* the reader's next message, which is the one order that
     * defeats the purpose.
     *
     * Riding along with the next message costs nothing, arrives before the model acts, and is not
     * a `user_message` the human never sent — it is part of one they did.
     */
    record.pendingBranchNote = `[GoodHarness] This working tree is now on branch ${switched.value.name}. Any files you read earlier may have changed, so re-read before relying on them.`;
    this.touch(record);
    return switched.value;
  }

  /**
   * Ask git where the Scope is now, and record it if that is news.
   *
   * Called where there is reason to believe the answer changed — at create, on Revive, after a
   * switch, and at the end of a turn. That last one is not optional: tools are pre-approved
   * (ADR 0004), so the *model* can run `git checkout`, and without it the reported branch would be
   * a stale claim a reader trusts. Never polled, which is why `SessionSummary.branch` is documented
   * as the last branch observed rather than a live one.
   */
  private async refreshBranch(record: SessionRecord): Promise<void> {
    if (!isRepository(record.scope)) return;
    const generation = (record.branchGeneration += 1);
    const found = await head(record.scope);
    // A repository git cannot answer about is left as it was: this runs off the critical path, and
    // there is no reader to tell.
    if (!found.ok) return;
    // Something newer has been learned or done while this was in flight, so this answer is already
    // history. Dropping it is the whole point of the generation.
    if (record.branchGeneration !== generation) return;
    this.announceBranch(record, found.value);
  }

  /**
   * Record where the Scope is, if that is news.
   *
   * Bumps the generation, so an older refresh still in flight cannot land on top of what this says.
   * A switch is the case that matters: it *knows* the answer, and must outrank any reading taken
   * before it happened.
   */
  private announceBranch(record: SessionRecord, branch: Branch): void {
    record.branchGeneration += 1;
    if (record.branch?.name === branch.name && record.branch?.detached === branch.detached) return;
    record.branch = branch;
    record.log.append({ type: "branch_changed", branch });
  }

  async dispose(sessionId: string, reason = "disposed"): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const session = record.session;
    record.session = undefined;
    record.status = "ended";
    record.queue.length = 0;
    await session?.dispose();
    record.log.append({ type: "session_ended", reason });
    this.touch(record);
    this.announceClosed(sessionId);
  }

  /**
   * Settle an Agent Session: the engineer declaring they are done with it.
   *
   * The Backend Session stops and the retention clock starts, but unlike `dispose` this is not
   * terminal — the transcript stays readable and a Revive (or the next message) un-settles it.
   * That reversibility is the point: a Settle you regret in the morning is recoverable, while one
   * you forget about is reaped (ADR 0006).
   */
  async settle(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    if (record.status === "ended") throw new Error(`Session ${sessionId} has ended`);
    if (record.status === "settled") return;

    const session = record.session;
    record.session = undefined;
    record.status = "settled";
    record.queue.length = 0;
    record.turnInFlight = false;
    await session?.dispose();
    // Close a turn we are interrupting before recording the Settle. Leaving it open would let the
    // restart path close it *after* session_settled, and a trailing turn_ended reduces to idle —
    // the rail would say settled while the pane said idle.
    this.closeOpenSubagents(record, record.log.since(0));
    const openTurn = openTurnId(record.log.since(0));
    if (openTurn) record.log.append({ type: "turn_ended", turnId: openTurn, reason: "aborted" });
    record.log.append({ type: "session_settled" });
    // Stamps updatedAt, which is what starts the retention clock: a Settled Agent Session runs
    // nothing and so records no further activity, and it always gets a full window.
    this.touch(record);
    this.announceClosed(sessionId);
  }

  /**
   * Delete Settled Agent Sessions whose retention window has passed. Only Settled ones: no other
   * state is deleted on a rule its owner did not opt into.
   *
   * Takes `now` so it can be tested without waiting, and returns what it removed.
   */
  async reap(now = Date.now()): Promise<string[]> {
    // Asked, not remembered: the Settings own this value and it may have changed since startup.
    const retention = typeof this.retention === "function" ? this.retention() : this.retention;
    if (retention === "never") return [];

    const reaped: string[] = [];
    for (const record of [...this.sessions.values()]) {
      if (record.status !== "settled") continue;
      const settledAt = Date.parse(record.updatedAt);
      // An unreadable timestamp means we cannot know the age; leaving it is the safe failure.
      if (Number.isNaN(settledAt) || now - settledAt < retention) continue;

      // Before deleting the session, so a worktree that cannot be removed leaves its Agent Session
      // in place to be retried on the next sweep rather than stranding a directory whose owner is
      // gone. `deleteSession` removes only `<root>/sessions/<id>`, so it can never take a worktree
      // with it by accident.
      await this.releaseWorktree(record);

      record.log.closeSubscribers();
      this.sessions.delete(record.id);
      this.store?.deleteSession(record.id);
      reaped.push(record.id);
    }
    for (const sessionId of reaped) this.announceClosed(sessionId);
    return reaped;
  }

  /**
   * Remove a reaped session's worktree, but only while it is clean.
   *
   * `git worktree remove` never deletes the branch ref or the commits on it, so committed work
   * survives a reap and is reachable by name afterwards. The only thing at risk is what was never
   * committed, which is why one `status --porcelain` is the whole safety rule — and why a dirty
   * worktree is left where it is and announced instead.
   */
  private async releaseWorktree(record: SessionRecord): Promise<void> {
    const worktree = record.worktree;
    if (!worktree) return;

    const kept = (reason: string) => {
      for (const listener of this.keptListeners) {
        listener({ path: worktree.path, branch: worktree.branch, reason });
      }
    };

    const clean = await isClean(worktree.path);
    if (!clean.ok) {
      kept(clean.failure.message);
      return;
    }
    if (!clean.value) {
      kept("it has uncommitted changes");
      return;
    }

    const removed = await removeWorktree({ repo: worktree.repo, path: worktree.path });
    if (!removed.ok) kept(removed.failure.message);
  }

  /** Stop running work without ending the Agent Sessions: they become Dormant and can be revived. */
  async shutdown(): Promise<void> {
    for (const record of this.sessions.values()) {
      if (!record.session) continue;
      const session = record.session;
      record.session = undefined;
      record.status = "dormant";
      record.queue.length = 0;
      record.turnInFlight = false;
      await session.dispose();
      this.closeOpenSubagents(record, record.log.since(0));
      record.log.append({ type: "session_dormant", reason: "host shutdown" });
      this.persist(record);
    }
  }

  async execute(command: Command): Promise<unknown> {
    switch (command.type) {
      case "create":
        return await this.create({
          scope: command.scope,
          backend: command.backend,
          ...(command.modelId === undefined ? {} : { modelId: command.modelId }),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
          ...(command.worktree === undefined ? {} : { worktree: command.worktree }),
        });
      case "send":
        return await this.send(command.sessionId, command.text, command.when, command.attachments);
      case "abort":
        return await this.abort(command.sessionId);
      case "revive":
        return await this.revive(command.sessionId);
      case "dispose":
        return await this.dispose(command.sessionId);
      case "settle":
        return await this.settle(command.sessionId);
      case "set_model":
        return await this.setModel(command.sessionId, command.modelId);
      case "set_effort":
        return await this.setEffort(command.sessionId, command.effort);
      case "switch_branch":
        return await this.switchBranch(command.sessionId, command.branch);
      case "compact":
        return await this.compact(command.sessionId, command.instructions);
      case "list_skills":
        return await this.listSkills(command.sessionId);
      case "list":
        return this.list();
    }
  }

  private async startBackendSession(record: SessionRecord): Promise<BackendSession> {
    const backend = this.backendFor(record.backendName);
    const session = await backend.create({
      scope: record.scope,
      emit: (event) => this.onBackendEvent(record.id, event),
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      ...(record.resumeToken === undefined ? {} : { resume: record.resumeToken }),
      ...(record.spend === undefined ? {} : { priorSpend: record.spend }),
      ...(this.store ? { stateDir: this.store.backendDir(record.id) } : {}),
    });
    record.session = session;
    record.capabilities = session.capabilities;
    this.captureResumeToken(record);
    return session;
  }

  /**
   * A turn left open by an unclean shutdown is closed on load rather than left hanging. The
   * transcript is append-only (ADR 0001), so we record that we now know it ended instead of
   * rewriting the turn that never finished.
   */
  private closeTornTurn(record: SessionRecord, entries: LoggedEvent[]): void {
    this.closeOpenSubagents(record, entries);
    const openTurn = openTurnId(entries);
    if (!openTurn) return;
    record.log.append({ type: "turn_ended", turnId: openTurn, reason: "aborted" });
  }

  /**
   * Close every Subagent the transcript still has running.
   *
   * A Subagent cannot outlive the turn that spawned it (ADR 0015), so one still running when the
   * turn is gone is a record of something that will never finish — on a Revive it renders as a
   * subagent working forever, with a spinner nothing will ever stop. Aborted for the same reason a
   * torn turn is: the work stopped, and nobody can say whether it had succeeded.
   */
  private closeOpenSubagents(record: SessionRecord, entries: LoggedEvent[]): void {
    for (const open of openSubagents(entries)) {
      record.log.append({ type: "subagent", ...open, state: "aborted" });
    }
  }

  private async dispatch(record: SessionRecord, message: QueuedMessage): Promise<void> {
    if (!record.session) throw new Error(`Session ${record.id} has no Backend Session`);
    const { text, attachments } = message;
    const note = record.pendingBranchNote;
    record.pendingBranchNote = undefined;
    /*
     * After the human's words, not before them.
     *
     * A backend expands a Skill the human picked — `/tdd`, `/code-review` — only when the name is at
     * the very start of the message, and a note prepended here moves it off that first character. It
     * worked until the turn after someone switched branch, and then quietly became an ordinary
     * message asking the model about the word "/tdd". Ordering within one message is not what makes
     * the note work: it arrives before the model acts either way.
     */
    const sent = note === undefined ? text : `${text}\n\n${note}`;

    record.turnInFlight = true;
    record.status = "running";
    record.log.append({
      type: "user_message",
      id: randomUUID(),
      text: sent,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // Titled from what its owner actually typed, never from `sent`. A switch made before the first
    // message would otherwise name the Agent Session after the note, and permanently: the rename
    // fires only while the title is still the Scope. An Attachment never titles anything either, so
    // a wordless paste falls to firstLine's own "Untitled session" rather than to a filename.
    if (record.title === record.scope) record.title = firstLine(text);
    this.touch(record);
    await record.session.prompt(sent, this.loadAttachments(record.id, attachments));
  }

  /**
   * The bytes for a dispatch, base64 for whichever SDK is about to receive them.
   *
   * Read at dispatch rather than held from the send, because a queued message may wait out a long
   * turn and the disk is where it is already durable. An id whose file has gone is skipped rather
   * than fatal: it can only mean the session's directory was interfered with, and losing an image
   * from a turn is a smaller harm than losing the words that came with it.
   */
  private loadAttachments(sessionId: string, ids: string[]): PromptAttachment[] | undefined {
    if (ids.length === 0) return undefined;
    const loaded: PromptAttachment[] = [];
    for (const id of ids) {
      const mediaType = mediaTypeOf(id);
      const bytes = mediaType ? this.store?.readAttachment(sessionId, id) : undefined;
      if (mediaType && bytes) loaded.push({ mediaType, data: bytes.toString("base64") });
    }
    return loaded.length > 0 ? loaded : undefined;
  }

  private flushBuffered(record: SessionRecord): void {
    const buffered = record.buffered ?? [];
    record.buffered = undefined;
    for (const event of buffered) this.onBackendEvent(record.id, event);
  }

  private onBackendEvent(sessionId: string, event: BackendEvent): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.status === "ended" || record.status === "settled") return;
    if (record.buffered) {
      record.buffered.push(event);
      return;
    }

    record.log.append(event);
    this.touch(record);

    // Kept current so a Revive can hand the running total back to the next Backend Session, which
    // counts only its own run.
    if (event.type === "context_usage" && event.spend) record.spend = event.spend;

    if (event.type === "turn_ended") {
      record.turnInFlight = false;
      record.status = "idle";
      this.captureResumeToken(record);
      // Tools are pre-approved (ADR 0004), so the model can have run `git checkout` during the turn
      // it just finished. Off the critical path, and announces only on a difference.
      void this.refreshBranch(record);
      void this.drain(record);
    }
  }

  private captureResumeToken(record: SessionRecord): void {
    const token = record.session?.resumeToken();
    if (token && token !== record.resumeToken) {
      record.resumeToken = token;
      this.persist(record);
    }
  }

  private async drain(record: SessionRecord): Promise<void> {
    const next = record.queue.shift();
    if (next === undefined) return;
    record.log.append({ type: "queue_changed", pending: pendingTexts(record.queue) });
    try {
      await this.dispatch(record, next);
    } catch (error) {
      record.log.append({ type: "notice", level: "error", text: errorMessage(error) });
    }
  }

  private newLog(sessionId: string, existing?: LoggedEvent[]): SessionLog {
    const store = this.store;
    return new SessionLog(sessionId, {
      ...(existing ? { existing } : {}),
      ...(store ? { sink: (entry) => store.append(entry) } : {}),
    });
  }

  private backendFor(name: string): AgentBackend {
    const backend = this.backends.get(name);
    if (!backend) throw new Error(`Unknown backend: ${name}`);
    return backend;
  }

  private record(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    return record;
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = new Date().toISOString();
    this.persist(record);
  }

  private persist(record: SessionRecord): void {
    if (!this.store) return;
    const meta: SessionMeta = {
      id: record.id,
      scope: record.scope,
      backend: record.backendName,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      ...(record.resumeToken === undefined ? {} : { resumeToken: record.resumeToken }),
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
    };
    this.store.writeMeta(meta);
  }
}

/** The turn still open at the end of these entries, if any. */
function openTurnId(entries: LoggedEvent[]): string | undefined {
  let openTurn: string | undefined;
  for (const entry of entries) {
    if (entry.event.type === "turn_started") openTurn = entry.event.turnId;
    if (entry.event.type === "turn_ended") openTurn = undefined;
  }
  return openTurn;
}

function lastEventType(entries: LoggedEvent[]): string | undefined {
  return entries.at(-1)?.event.type;
}

/** The last branch the transcript recorded, so a restart does not have to ask git again. */
function branchFrom(entries: LoggedEvent[]): Branch | undefined {
  let branch: Branch | undefined;
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type === "branch_changed") branch = event.branch;
  }
  return branch;
}

/**
 * Subagents the transcript last saw running or waiting.
 *
 * Derived rather than held on the record, in the style of `branchFrom` and `capabilitiesFrom`: a
 * Subagent belongs to a turn of a Backend Session, and the host outlives both. Reading it back
 * from the transcript is also what makes the restart path work at all — nothing was in memory.
 */
function openSubagents(entries: LoggedEvent[]): { subagentId: string; name: string }[] {
  const open = new Map<string, string>();
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type !== "subagent") continue;
    if (event.state === "running" || event.state === "waiting") open.set(event.subagentId, event.name);
    else open.delete(event.subagentId);
  }
  return [...open].map(([subagentId, name]) => ({ subagentId, name }));
}

/** What the transcript last reported this Agent Session had spent, across every Backend Session. */
function spendFrom(entries: LoggedEvent[]): Spend | undefined {
  let spend: Spend | undefined;
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type === "context_usage" && event.spend) spend = event.spend;
  }
  return spend;
}

function capabilitiesFrom(entries: LoggedEvent[]): Capabilities | undefined {
  let capabilities: Capabilities | undefined;
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type === "session_started" || event.type === "capabilities_changed") {
      capabilities = event.capabilities;
    }
  }
  return capabilities;
}

/**
 * What `queue_changed` says is waiting.
 *
 * Texts only, and deliberately so: `queue_changed` is a Presentation Transcript event, replayed on
 * every load, and widening its shape so a client could preview a queued message's Attachments would
 * change a record that is already written. The accepted cost is that a queued paste is not visible
 * until its turn dispatches, which is one turn of patience for a shape nobody has to migrate.
 */
function pendingTexts(queue: QueuedMessage[]): string[] {
  return queue.map((message) => message.text);
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Untitled session";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
