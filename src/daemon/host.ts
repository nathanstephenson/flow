import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendSession, PromptAttachment } from "../backend/types.ts";
import {
  isAttachmentMediaType,
  mediaTypeOf,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BASE64_BYTES,
  type IncomingAttachment,
} from "../protocol/attachments.ts";
import { deriveStatus, railBand } from "../client/status.ts";
import type {
  Command,
  SendWhen,
  SessionLifecycle,
  SessionStatus,
  SessionSummary,
} from "../protocol/commands.ts";
import type {
  AgentEvent,
  BackendEvent,
  Capabilities,
  EffortLevel,
  LoggedEvent,
  PermissionDecision,
  Producer,
  Question,
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
import { probeModels, type BackendModels } from "./models.ts";
import type { SessionMeta, TitleSource, TranscriptStore } from "./store.ts";
import { nameInput, SummaryModelSpare } from "./summariser.ts";

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
  /**
   * The half of the old `status` worth writing down. The other half — running, awaiting, idle — is
   * worked out by `activityOf` from the two fields below, because a restart destroys all three of
   * them anyway (ADR 0003) and a stored copy could only be wrong.
   */
  lifecycle: SessionLifecycle;
  /**
   * Set by the host the moment it dispatches, not when the backend reports `turn_started`. A
   * backend may take a tick to acknowledge, and in that window a second `after_turn` send would
   * otherwise see an idle session and jump the queue.
   *
   * This, not the derived status, is what every "refuse it mid-turn" guard must read. An Agent
   * Session blocked on a Permission Prompt derives `awaiting` rather than `running` while its turn
   * is very much still open.
   */
  turnInFlight: boolean;
  /**
   * The Permission Prompts, Enquiries, Subagents and Background Calls the transcript has open,
   * indexed by id so the rail can be answered without reading it.
   *
   * **An index, not the record of truth.** `openPermissions`, `openEnquiries`, `openSubagents` and
   * `openBackgroundCalls` still scan the transcript wherever a terminal snapshot has to be written,
   * and these are kept alongside only because `list()` runs for every Agent Session on a
   * two-second poll and a
   * scan there is the whole transcript, per session, per poll. The asymmetry is deliberate: if the
   * index drifts, a dot is wrong until the next event; if the index were believed by the code that
   * closes torn prompts, a drift would leave a dangling `asked` on disk that replays into a
   * composer nobody can unlock.
   *
   * Sets of ids rather than counters because snapshots repeat — a Subagent reports `running` many
   * times, and counting arrivals rather than transitions would never come back down.
   */
  openPermissionIds: Set<string>;
  openEnquiryIds: Set<string>;
  /** Never affects occupancy: a backgrounded Subagent holds nothing (ADR 0016). */
  openSubagentIds: Set<string>;
  /** Never affects occupancy either: a Background Call holds nothing (ADR 0021). */
  openBackgroundCallIds: Set<string>;
  /**
   * When this Agent Session last came to rest — what orders the rail inside a band, and what its
   * row prints. See `SessionSummary.restingAt` for why it is not `updatedAt`.
   */
  restingAt: string;
  /** Set while Settled. What ADR 0006's retention window is measured from. */
  settledAt: string | undefined;
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
   * Where the title came from, and so what may overwrite it.
   *
   * This used to be inferred — `title === scope` meant "still the placeholder". One writer could
   * get away with that; two cannot. The Summary Model's name lands seconds after the first line is
   * already in place, so the sentinel is false by the time it needs consulting, and there would be
   * no way to tell a name a model produced from one a human is looking at.
   *
   * The order is one-way: a `"scope"` title yields to the first line, a `"first-line"` title yields
   * to a summary, and a `"summary"` title yields to nothing but another rename.
   */
  titleSource: TitleSource;
  /**
   * Bumped every time someone sets out to name this Agent Session, so a slower answer cannot
   * overwrite a newer one — the same hazard `branchGeneration` exists for, and for the same reason:
   * naming is `void`ed at dispatch and can still be in flight when a human clicks Rename.
   */
  titleGeneration: number;
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
  /**
   * The Standing Authorisations in force, read at each Backend Session create.
   *
   * A function for the reason `retention` is one, and given by the daemon as `ConfigStore`'s
   * `standingAuthorisations`: a grant made an hour ago must reach a session started now without
   * restarting the daemon. Omitted means none, which is what every test wants.
   */
  standingAuthorisations?: () => readonly string[];
  /**
   * Grant a Standing Authorisation — what an Always decision leaves behind.
   *
   * A bound function rather than the ConfigStore itself, so this object stays ignorant of
   * config.json (ADR 0009): it owns Agent Sessions, and a file full of typefaces is not its
   * business. Omitted means an Always authorises the call and is not remembered, which is what a
   * host built without a Settings file can honestly offer.
   */
  allowTool?: (name: string) => void;
  /**
   * The Default Model for a Backend Adapter — the model a new Agent Session starts on when its
   * creator named none.
   *
   * A function for the reason `retention` is one, and given by the daemon as `ConfigStore`'s
   * `defaultModel`. Omitted means the adapter picks, which is what every test wants and what a host
   * built without a Settings file can honestly offer.
   */
  defaultModel?: (backend: string) => string | undefined;
  /**
   * The Summary Model, and the Backend Adapter to reach it through — the model that names an Agent
   * Session (ADR 0020).
   *
   * A function for the reason the two above are. Omitted means no Agent Session is ever named by a
   * model: the automatic naming does not run, and a `rename` is refused with something a human can
   * read.
   */
  summaryModel?: () => { backend: string; modelId: string; automatic: boolean } | undefined;
};

/** Owns every Agent Session, and the Steering Queue that sits above all backends (ADR 0002). */
export class SessionHost {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly backends = new Map<string, AgentBackend>();
  /** Model probes by backend name, held in flight rather than resolved — see `models`. */
  private readonly modelProbes = new Map<string, Promise<BackendModels>>();
  /**
   * One Summary Model session, booted before a naming needs it (ADR 0020).
   *
   * Belongs to no Agent Session, and is deliberately not wired to `announceClosed`, the reaper or
   * `settle` — it is a throwaway that outlives any one of them, in the same way `modelProbes` is.
   */
  private readonly summarySpare = new SummaryModelSpare();
  private readonly store: TranscriptStore | undefined;
  private readonly retention: number | "never" | (() => number | "never");
  private readonly standingAuthorisations: (() => readonly string[]) | undefined;
  private readonly allowTool: ((name: string) => void) | undefined;
  private readonly defaultModel: ((backend: string) => string | undefined) | undefined;
  private readonly summaryModel:
    | (() => { backend: string; modelId: string; automatic: boolean } | undefined)
    | undefined;
  private readonly closedListeners = new Set<(sessionId: string) => void>();
  private readonly keptListeners = new Set<
    (kept: { path: string; branch: string; reason: string }) => void
  >();

  constructor(options: SessionHostOptions = {}) {
    this.store = options.store;
    this.retention = options.retention ?? "never";
    this.standingAuthorisations = options.standingAuthorisations;
    this.allowTool = options.allowTool;
    this.defaultModel = options.defaultModel;
    this.summaryModel = options.summaryModel;
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

  /**
   * What models each Backend Adapter can reach — what the Providers section offers to choose from.
   *
   * **Memoised for the life of the daemon**, which is a deliberate departure from `/api/branches`
   * and `/api/directories`, the two other queries beside the Settings. Those are asked fresh
   * because their answers change outside Flow between one keystroke and the next. This one changes
   * when an account's entitlements do — rarely — and answering it spawns a process per backend, so
   * asking on every render of a settings page would be a real cost for a list that had not moved.
   * `refresh` is the Check again button, for the day it has.
   *
   * In flight rather than resolved is what is remembered, so two clients opening the page at once
   * spawn one probe between them rather than one each.
   */
  async models(scope: string, refresh = false): Promise<BackendModels[]> {
    if (refresh) this.modelProbes.clear();
    const probes = [...this.backends.values()].map((backend) => {
      const held = this.modelProbes.get(backend.name);
      if (held) return held;
      const probe = probeModels(backend, scope);
      this.modelProbes.set(backend.name, probe);
      return probe;
    });
    return await Promise.all(probes);
  }

  logFor(sessionId: string): SessionLog {
    return this.record(sessionId).log;
  }

  statusOf(sessionId: string): SessionStatus {
    return this.activityOf(this.record(sessionId));
  }

  /**
   * Three `Set.size` reads and a comparison, because this runs for every Agent Session on every
   * `GET /api/sessions` — the same budget `branch` is held on the record to stay inside.
   */
  private activityOf(record: SessionRecord): SessionStatus {
    return deriveStatus({
      lifecycle: record.lifecycle,
      turnInFlight: record.turnInFlight,
      awaiting: record.openPermissionIds.size > 0 || record.openEnquiryIds.size > 0,
    });
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((record) => ({
        id: record.id,
        scope: record.scope,
        backend: record.backendName,
        status: this.activityOf(record),
        title: record.title,
        restingAt: record.restingAt,
        activeSubagents: record.openSubagentIds.size,
        activeBackgroundCalls: record.openBackgroundCallIds.size,
        ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
        lastSeq: record.log.lastSeq,
        ...(record.capabilities ? { capabilities: record.capabilities } : {}),
        ...(record.branch ? { branch: record.branch } : {}),
        ...(record.worktree ? { worktree: true as const } : {}),
      }))
      /*
       * Banded by how alive an Agent Session is, then by recency inside each band.
       *
       * One recency key alone put an Agent Session that finished ten minutes ago above one still
       * working, which is backwards: the top of a list is where a reader looks for what is
       * happening. Bands fix the order without giving back the stability they were introduced for —
       * a row moves when its band changes and at no other time, so a turn streams for an hour
       * without touching the list.
       *
       * Settled and Ended sort by when they were filed away rather than by `restingAt`, which for
       * them is whenever they happened to go idle beforehand — ordering them by something their
       * owner never did.
       */
      .sort((left, right) => {
        const band = railBand(left) - railBand(right);
        if (band !== 0) return band;
        // `?? restingAt` on both sides rather than a branch on whether each has been Settled: the
        // bottom band holds Settled and Ended together and only one of them carries `settledAt`, so
        // comparing different fields per row would make this comparator non-transitive.
        const by = (summary: SessionSummary): string => summary.settledAt ?? summary.restingAt;
        return by(right).localeCompare(by(left));
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
        lifecycle: lifecycleFrom(meta),
        turnInFlight: false,
        openPermissionIds: new Set(openPermissions(entries).map((open) => open.callId)),
        openEnquiryIds: new Set(openEnquiries(entries).map((open) => open.askId)),
        openSubagentIds: new Set(openSubagents(entries).map((open) => open.subagentId)),
        openBackgroundCallIds: new Set(openBackgroundCalls(entries).map((open) => open.callId)),
        // A meta written before the split has neither, and `updatedAt` is what both used to be.
        restingAt: meta.restingAt ?? meta.updatedAt,
        settledAt: meta.settledAt ?? (lifecycleFrom(meta) === "settled" ? meta.updatedAt : undefined),
        buffered: undefined,
        queue: [],
        title: meta.title,
        // Read leniently, in config.json's manner: a meta.json written before Agent Sessions were
        // named by a model has no `titleSource`, and the sentinel that used to stand in for one
        // still answers correctly for it. So nothing has to be migrated, and an old session whose
        // title is still its Scope is titled by its next message exactly as it always was.
        titleSource: meta.titleSource ?? (meta.title === meta.scope ? "scope" : "first-line"),
        titleGeneration: 0,
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
      // Empties all three sets seeded above: a torn turn's prompts and Subagents are closed here,
      // and nothing can be open on an Agent Session with no Backend Session attached.
      this.closeTornTurn(record, entries);
      // Dormancy has to be visible to a client reducing the transcript, or a session with nothing
      // running still looks ready to type at. A clean shutdown already recorded it.
      if (record.lifecycle === "dormant" && lastEventType(record.log.since(0)) !== "session_dormant") {
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
      lifecycle: "live",
      turnInFlight: false,
      openPermissionIds: new Set(),
      openEnquiryIds: new Set(),
      openSubagentIds: new Set(),
      openBackgroundCallIds: new Set(),
      // A brand new Agent Session is its owner's turn from the moment it exists, which is what puts
      // it at the top of the rail.
      restingAt: now,
      settledAt: undefined,
      buffered: undefined,
      queue: [],
      title: scope,
      titleSource: "scope",
      titleGeneration: 0,
      branch: undefined,
      branchGeneration: 0,
      worktree,
      pendingBranchNote: undefined,
      capabilities: undefined,
      spend: undefined,
      resumeToken: undefined,
      /*
       * Resolved here and never again.
       *
       * Not in `startBackendSession`, which is the tempting place: that path also runs on a Revive,
       * so reading the Default Model there would move a week-old Dormant Agent Session onto whatever
       * the default is *today*, silently, on the turn its owner came back to write. Resolving once
       * and persisting to `SessionMeta.modelId` is what makes the choice stick for this session's
       * life — the same shape as the Standing Authorisations snapshot in BackendCreateOptions.
       */
      modelId: options.modelId ?? this.defaultModel?.(backend.name),
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
    /*
     * Somebody who has just made an Agent Session is about to type into it, and naming what they
     * type means booting a Summary Model session that takes the better part of a minute. Started
     * here so that most of that is paid while they are still writing.
     *
     * Called unconditionally, including when no Summary Model is configured, because that is also
     * how a spare gets dropped when somebody clears the Setting: nothing will ever *tell* us it
     * changed (ADR 0009), so a read-through is the only moment it can be noticed.
     */
    this.warmSummaryModel();
    return id;
  }

  /**
   * Boot a Summary Model session ahead of needing one, or drop the one held if the Setting is gone.
   *
   * The backend is resolved here rather than inside the spare because `backendFor` throws for a
   * name it does not know: a typo in `providers.summary.backend` must cost a worse Agent Session
   * *name*, never the Agent Session itself.
   */
  private warmSummaryModel(): void {
    const model = this.summaryModel?.();

    /*
     * Three cases, and the middle one is the reason this is not a one-liner.
     *
     * No Summary Model at all: drop whatever is held. This is the only moment a Setting somebody
     * cleared is ever noticed, because nothing pushes a change (ADR 0009).
     *
     * A Summary Model with automatic naming *off*: leave the spare exactly as it is. Not warmed,
     * because nothing will need one until somebody clicks Rename — and that path warms its own
     * replacement afterwards, so a second rename is fast without a daemon nobody is renaming in
     * holding an idle process. And not dropped either: a spare a rename just warmed must survive
     * the next Agent Session being created, or the two would fight over it.
     */
    if (!model) {
      this.summarySpare.warm(undefined, undefined);
      return;
    }
    if (!model.automatic) return;

    let backend: AgentBackend | undefined;
    try {
      backend = this.backendFor(model.backend);
    } catch {
      backend = undefined;
    }
    this.summarySpare.warm(backend, model);
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
    if (record.lifecycle === "ended") throw new Error(`Session ${sessionId} has ended`);
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
    // A backend that died without saying so can have left a prompt open with no path having run.
    // Self-deduplicating, so on every ordinary Revive this appends nothing.
    this.closeOpenEnquiries(record, record.log.since(0));
    this.closeOpenPermissions(record, record.log.since(0));
    this.closeOpenSubagents(record, record.log.since(0));
    this.closeOpenBackgroundCalls(record, record.log.since(0));
    await this.startBackendSession(record);
    record.lifecycle = "live";
    // Un-settled, so the retention window starts again from the next Settle rather than from the
    // one this Revive just undid.
    record.settledAt = undefined;
    record.restingAt = new Date().toISOString();
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
  /**
   * Answer an Enquiry this Agent Session is holding open.
   *
   * **Never Revives**, which is the one place this parts company with `send` and `compact`. Those
   * carry something still meaningful after a Revive; this resolves a promise held by a Backend
   * Session that no longer exists, so reviving here would start a process and spend money to answer
   * nothing. Dormant, Settled and Ended are all refused, and the transcript already carries the
   * `aborted` snapshot that says why.
   *
   * **Writes no `user_message`.** An answer is not something anyone said to the model — it is the
   * input to a tool call the model itself made — and a turn is already in flight, so there is nothing
   * to occupy and nothing to queue. What a reader sees is the `answered` snapshot the adapter emits.
   *
   * Arity is checked here rather than left to the adapter, because getting it wrong is not an error
   * the model should be asked to cope with: a client sending two answers for three Questions would
   * otherwise produce an `answers` map the model reads as consent nobody gave.
   */
  async answerEnquiry(sessionId: string, askId: string, answers: string[][]): Promise<void> {
    const record = this.record(sessionId);
    const session = record.session;
    if (!session) {
      throw new CommandRefused(
        `Agent Session ${sessionId} is ${this.activityOf(record)}; the question it was asked can no longer be answered`,
      );
    }
    // The flag, never the method — the rule `compact` sets, so an adapter cannot be half-capable.
    if (!session.capabilities.enquiries || !session.answerEnquiry) {
      throw new CommandRefused(`${record.backendName} cannot carry an answer to a question`);
    }

    const open = openEnquiries(record.log.since(0)).find((enquiry) => enquiry.askId === askId);
    if (!open) throw new CommandRefused(`That question is no longer open`);
    if (answers.length !== open.questions.length) {
      throw new CommandRefused(
        `That question has ${open.questions.length} parts and must be answered in one act`,
      );
    }

    // False is a race, not a fault: the transcript said it was open and the backend says otherwise,
    // which is what an abort landing between the two looks like.
    if (!(await session.answerEnquiry(askId, answers))) {
      throw new CommandRefused(`That question is no longer open`);
    }
    this.touch(record);
  }

  /**
   * Authorise, or refuse, one tool call this Agent Session is holding open.
   *
   * Refused when there is no Backend Session, and **never Revives**, for the reason `answerEnquiry`
   * never does: the promise this settles died with the process that held it.
   *
   * Unlike `answerEnquiry` it does **not** read the transcript first. That scan buys arity checking
   * there, and a prompt has no arity — one decision settles one call. What is left would be an
   * O(transcript) walk per decision, on a record that grows all session, to produce a nicer message
   * for a race the adapter already reports by answering `false`. So this delegates, and turns the
   * `false` into the refusal.
   *
   * An `always` is persisted **after** the callback is settled, never before. Crashing between the
   * two then loses a Standing Authorisation and the next session asks once more — a cost already
   * accepted for a grant made in another session. The other order would leave a tool permanently
   * authorised that the human never saw run, in a turn that then died: a record of consent to
   * something that did not happen.
   */
  async answerPermission(sessionId: string, callId: string, decision: PermissionDecision): Promise<void> {
    const record = this.record(sessionId);
    const session = record.session;
    if (!session) {
      throw new CommandRefused(
        `Agent Session ${sessionId} is ${this.activityOf(record)}; what it was waiting to be allowed can no longer be authorised`,
      );
    }
    // The flag, never the method — the rule `compact` sets, so an adapter cannot be half-capable.
    if (!session.capabilities.permissions || !session.answerPermission) {
      throw new CommandRefused(`${record.backendName} cannot be asked before it acts`);
    }

    /*
     * Read before the decision, because deciding is what forgets it — but only for an `always`,
     * which is the one decision that needs the name.
     *
     * `answerEnquiry` scans unconditionally because it has an arity to check. There is nothing to
     * check here, so on the common path this would be an O(transcript) walk, per decision, on a
     * record that grows all session — to fetch a string two of the three decisions throw away.
     */
    const tool =
      decision === "always"
        ? openPermissions(record.log.since(0)).find((open) => open.callId === callId)?.tool
        : undefined;

    // False is a race, not a fault, and it is also what says to persist nothing: an abort landing
    // between a client's click and this call must not leave a Standing Authorisation behind.
    if (!(await session.answerPermission(callId, decision))) {
      throw new CommandRefused(`That tool call is no longer waiting to be authorised`);
    }
    this.touch(record);

    if (decision !== "always" || tool === undefined) return;
    try {
      this.allowTool?.(tool);
    } catch (error) {
      // Partial success, and the register `applyEffort` uses for exactly this shape: the tool ran, and
      // only the remembering failed. Reporting it as a refusal would be a lie about what happened.
      record.log.append({
        type: "notice",
        level: "warn",
        text: `Allowed ${tool} once, but could not remember it: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.touch(record);
    }
  }

  async compact(sessionId: string, instructions?: string): Promise<void> {
    const record = this.record(sessionId);
    // Refused rather than left to `revive`'s own throw, which would reach the client as a 500 for
    // something it should be told plainly.
    if (record.lifecycle === "ended") {
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
   * `turnInFlight` without a gap between reading it and acting on it.
   *
   * Reads `turnInFlight` rather than the derived status, and the difference is a working tree. An
   * Agent Session blocked on a Permission Prompt derives `awaiting`, not `running`, while its turn
   * is still open around a tool call — so a status comparison here would quietly stop refusing and
   * move the branch under it.
   */
  async switchBranch(sessionId: string, branch: string): Promise<Branch> {
    const record = this.record(sessionId);
    if (record.turnInFlight) {
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
    record.pendingBranchNote = `[Flow] This working tree is now on branch ${switched.value.name}. Any files you read earlier may have changed, so re-read before relying on them.`;
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
    record.lifecycle = "ended";
    record.turnInFlight = false;
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
    if (record.lifecycle === "ended") throw new Error(`Session ${sessionId} has ended`);
    if (record.lifecycle === "settled") return;

    const session = record.session;
    record.session = undefined;
    record.lifecycle = "settled";
    // The retention window runs from here, not from the last thing that happened: settling
    // something untouched for a week still grants it a full window (ADR 0006).
    record.settledAt = new Date().toISOString();
    record.queue.length = 0;
    record.turnInFlight = false;
    await session?.dispose();
    // Close a turn we are interrupting before recording the Settle. Leaving it open would let the
    // restart path close it *after* session_settled, and a trailing turn_ended reduces to idle —
    // the rail would say settled while the pane said idle.
    this.closeOpenSubagents(record, record.log.since(0));
    this.closeOpenBackgroundCalls(record, record.log.since(0));
    this.closeOpenEnquiries(record, record.log.since(0));
    this.closeOpenPermissions(record, record.log.since(0));
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
      if (record.lifecycle !== "settled") continue;
      const settledAt = record.settledAt === undefined ? NaN : Date.parse(record.settledAt);
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

  /**
   * Name this Agent Session again, from its Presentation Transcript, with the Summary Model.
   *
   * **Never Revives** (ADR 0003). It reads the transcript, not the Conversation Context — two
   * different records (ADR 0001), and only the first can be read with nothing running. So a Dormant
   * Agent Session stays Dormant, no Backend Session is started on it, and no turn is opened on it:
   * the work happens in a throwaway session somewhere else entirely.
   *
   * **Awaited**, unlike the naming at dispatch, because a human clicked this and is watching for the
   * result. Every way it can fail is a refusal they can read rather than a silence.
   */
  async rename(sessionId: string): Promise<string> {
    const record = this.record(sessionId);
    const summary = this.summaryModel?.();
    if (!summary) throw new CommandRefused("No Summary Model is configured — choose one in Settings");

    const entries = record.log.since(0);
    if (!entries.some((entry) => entry.event.type === "user_message")) {
      throw new CommandRefused("This Agent Session has nothing to name yet");
    }

    // Refused readably rather than thrown as a 500: nothing validates a model id or a backend name
    // when the Settings are saved (ADR 0020), so naming a backend this build lacks is an ordinary
    // typo and the person who made it is the one reading this message.
    let backend: AgentBackend;
    try {
      backend = this.backendFor(summary.backend);
    } catch {
      throw new CommandRefused(`No backend named ${summary.backend} — check the Summary Model in Settings`);
    }

    const generation = (record.titleGeneration += 1);
    const name = await this.summarySpare.name(backend, summary, nameInput(entries));
    if (name === undefined) throw new CommandRefused("Could not name this Agent Session");
    // Refused rather than applied when something newer has already been asked for. A human who
    // clicked twice wants the second answer, and the first arriving afterwards must not undo it.
    if (record.titleGeneration !== generation) throw new CommandRefused("This Agent Session was renamed again");

    record.title = name;
    record.titleSource = "summary";
    this.touch(record);
    return name;
  }

  /**
   * The automatic half: a name for the first message, applied if it is still wanted when it lands.
   *
   * Swallows everything. A name is a convenience and `firstLine` has already produced a usable one,
   * so a Summary Model that is missing, slow or talking nonsense costs the better name and nothing
   * else — least of all the turn the human is waiting on.
   */
  private async nameFromSummary(record: SessionRecord, text: string): Promise<void> {
    const summary = this.summaryModel?.();
    // `automatic` is the half of the Setting that governs *this* path only. A session whose owner
    // turned it off keeps the first line of what they typed, and `rename` still works — which is
    // the whole point of it being a switch rather than clearing the Summary Model.
    if (!summary?.automatic) return;

    const generation = (record.titleGeneration += 1);
    let name: string | undefined;
    try {
      name = await this.summarySpare.name(this.backendFor(summary.backend), summary, text);
    } catch {
      // An unknown backend named in the Settings, most likely. Silent, as everything on this path is.
      return;
    }
    if (name === undefined) return;

    /*
     * Looked up again rather than trusted, because ten seconds is long enough for this Agent Session
     * to have been Ended, Settled or reaped — and writing a title onto a record nobody holds any
     * more would persist a meta.json for a session that no longer exists.
     */
    const current = this.sessions.get(record.id);
    if (!current || current !== record) return;
    // `lifecycle`, not the derived activity: what disqualifies a session from being renamed is
    // that it is over, not that it happens to be mid-turn.
    if (current.lifecycle === "ended" || current.lifecycle === "settled") return;
    // Only a first-line name yields to this, and only if nothing newer has been asked for since.
    if (current.titleSource !== "first-line" || current.titleGeneration !== generation) return;

    current.title = name;
    current.titleSource = "summary";
    this.touch(current);
  }

  /** Stop running work without ending the Agent Sessions: they become Dormant and can be revived. */
  async shutdown(): Promise<void> {
    // First, so that a naming still in flight cannot warm a replacement on the way out — the
    // one-shot CLI runner shuts down microseconds before `process.exit`, and a spare booted in
    // that window is a child process nothing is left to dispose. Not awaited, and cannot be: see
    // `SummaryModelSpare.dispose`.
    this.summarySpare.dispose();
    for (const record of this.sessions.values()) {
      if (!record.session) continue;
      const session = record.session;
      record.session = undefined;
      record.lifecycle = "dormant";
      record.turnInFlight = false;
      record.queue.length = 0;
      record.turnInFlight = false;
      await session.dispose();
      this.closeOpenSubagents(record, record.log.since(0));
      this.closeOpenBackgroundCalls(record, record.log.since(0));
      this.closeOpenEnquiries(record, record.log.since(0));
      this.closeOpenPermissions(record, record.log.since(0));
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
      case "rename":
        return await this.rename(command.sessionId);
      case "compact":
        return await this.compact(command.sessionId, command.instructions);
      case "answer_enquiry":
        return await this.answerEnquiry(command.sessionId, command.askId, command.answers);
      case "answer_permission":
        return await this.answerPermission(command.sessionId, command.callId, command.decision);
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
      // Read here rather than held, so a Revive picks up every grant made since this Agent Session
      // last had a Backend Session — which is the whole of how a grant reaches an older session.
      ...(this.standingAuthorisations
        ? { standingAuthorisations: this.standingAuthorisations() }
        : {}),
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
    this.closeOpenBackgroundCalls(record, entries);
    // The daemon-restart case for an Enquiry: nothing was in memory to abandon its callback, and the
    // process holding it is gone. All that is left is to record that nobody will ever answer it.
    this.closeOpenEnquiries(record, entries);
    this.closeOpenPermissions(record, entries);
    const openTurn = openTurnId(entries);
    if (!openTurn) return;
    record.log.append({ type: "turn_ended", turnId: openTurn, reason: "aborted" });
  }

  /**
   * Close every Subagent the transcript still has running.
   *
   * A backgrounded Subagent outlives the turn that spawned it (ADR 0016), but none outlives its
   * Backend Session — they are children of the CLI process. So one still running when that session
   * is gone is a record of something that will never finish: on a Revive it renders as a subagent
   * working forever, with a spinner nothing will ever stop. Aborted for the same reason a torn turn
   * is: the work stopped, and nobody can say whether it had succeeded.
   */
  private closeOpenSubagents(record: SessionRecord, entries: LoggedEvent[]): void {
    for (const open of openSubagents(entries)) {
      record.log.append({ type: "subagent", ...open, state: "aborted" });
    }
    record.openSubagentIds.clear();
  }

  /**
   * Close every Background Call the transcript still has running.
   *
   * The same argument `closeOpenSubagents` makes, and it reaches the same place: a Background Call
   * outlives the turn that made it (ADR 0021) but not its Backend Session, being a child of the CLI
   * process. One still running when that session is gone would render on a Revive as a job working
   * forever with nothing that could ever stop it.
   *
   * A remotely-launched call is the honest exception — it may really still be running on another
   * machine — and is recorded aborted anyway, because Flow has no channel to hear about it again
   * and a card spinning on a promise nothing can keep is the worse of the two lies.
   */
  private closeOpenBackgroundCalls(record: SessionRecord, entries: LoggedEvent[]): void {
    for (const open of openBackgroundCalls(entries)) {
      record.log.append({ type: "background_call", ...open, state: "aborted" });
    }
    record.openBackgroundCallIds.clear();
  }

  /**
   * Record that an Enquiry nobody answered is over.
   *
   * Called beside `closeOpenSubagents` from every path that takes a Backend Session away, and always
   * *before* the `session_dormant` / `session_settled` line, so a state arriving after the marker
   * cannot reduce a pane back out of it.
   *
   * Self-deduplicating rather than conditional: it runs after `session.dispose()`, which is where a
   * live adapter abandons its own pending callbacks and emits these snapshots itself — so by the time
   * this reads the transcript there is usually nothing open, and it appends nothing. What it is for
   * is the cases where there was no adapter to do it: a daemon that restarted, or one whose backend
   * died without saying so.
   */
  private closeOpenEnquiries(record: SessionRecord, entries: LoggedEvent[]): void {
    for (const open of openEnquiries(entries)) {
      record.log.append({ type: "enquiry", ...open, state: "aborted" });
    }
    record.openEnquiryIds.clear();
  }

  /**
   * Record that a Permission Prompt nobody decided is over.
   *
   * Beside `closeOpenEnquiries`, called from the same three paths and self-deduplicating for the same
   * reason: a live adapter abandons its own callbacks in `dispose()` and emits these snapshots
   * itself, so this usually appends nothing. What it is for is a daemon that restarted, or a backend
   * that died without saying so — and the failure it prevents is worse here than there. A prompt left
   * open in a replayed transcript locks the composer on buttons whose promise died with the process,
   * so the human has a question they cannot answer and cannot dismiss.
   */
  private closeOpenPermissions(record: SessionRecord, entries: LoggedEvent[]): void {
    for (const open of openPermissions(entries)) {
      record.log.append({ type: "permission", ...open, state: "aborted" });
    }
    record.openPermissionIds.clear();
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
    record.log.append({
      type: "user_message",
      id: randomUUID(),
      text: sent,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // Titled from what its owner actually typed, never from `sent`. A switch made before the first
    // message would otherwise name the Agent Session after the note, and permanently: the rename
    // fires only while the title is still the placeholder. An Attachment never titles anything
    // either, so a wordless paste falls to firstLine's own "Untitled session" rather than a filename.
    if (record.titleSource === "scope") {
      record.title = firstLine(text);
      record.titleSource = "first-line";
      /*
       * And then, seconds later, something better.
       *
       * `void`ed rather than awaited: this is a model call that can take ten seconds, and the human
       * is waiting on their turn starting, not on its name. The first line is already in place, so
       * what arrives replaces a usable title rather than filling an empty one — no spinner, no
       * flicker into and out of blank. It can only happen on a first dispatch, so no *established*
       * name ever changes under its reader.
       */
      void this.nameFromSummary(record, text);
    }
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
    if (!record || record.lifecycle === "ended" || record.lifecycle === "settled") return;
    if (record.buffered) {
      record.buffered.push(event);
      return;
    }

    const before = this.activityOf(record);
    record.log.append(event);
    this.touch(record);
    this.indexOpen(record, event);

    // Kept current so a Revive can hand the running total back to the next Backend Session, which
    // counts only its own run.
    if (event.type === "context_usage" && event.spend) record.spend = event.spend;

    /*
     * Ordinarily redundant — `dispatch` and `compact` both set this before the adapter acknowledges,
     * for the race the field's own comment describes. It matters for the turn nobody asked for: a
     * backgrounded Subagent settling wakes the model on its own (ADR 0016), and the adapter mints a
     * turn for what it says. Without this the Steering Queue would believe the session idle and
     * dispatch into it, which is the very thing holding the turn open used to prevent.
     */
    if (event.type === "turn_started") {
      record.turnInFlight = true;
    }

    if (event.type === "turn_ended") {
      record.turnInFlight = false;
      this.captureResumeToken(record);
      // Tools are pre-approved (ADR 0004), so the model can have run `git checkout` during the turn
      // it just finished. Off the critical path, and announces only on a difference.
      void this.refreshBranch(record);
      void this.drain(record);
    }

    this.noteResting(record, before);
  }

  /**
   * Keep the open-prompt and open-Subagent index in step with the transcript.
   *
   * Only ever called from `onBackendEvent`, which is the one path every adapter event takes. The
   * host's own terminal snapshots go through `closeOpen*`, which clear these sets themselves.
   */
  private indexOpen(record: SessionRecord, event: BackendEvent): void {
    if (event.type === "permission") {
      toggle(record.openPermissionIds, event.callId, event.state === "asked");
    }
    if (event.type === "enquiry") {
      toggle(record.openEnquiryIds, event.askId, event.state === "asked");
    }
    if (event.type === "subagent") {
      toggle(record.openSubagentIds, event.subagentId, event.state === "running" || event.state === "waiting");
    }
    if (event.type === "background_call") {
      toggle(record.openBackgroundCallIds, event.callId, event.state === "running");
    }
    /*
     * Mirrors the reducer's own `turn_ended` arm, and has to. Neither an Enquiry nor a Permission
     * Prompt can outlive the turn that raised it, so an adapter that tore one down without emitting
     * its terminal snapshot would otherwise pin this Agent Session at `awaiting` for good.
     *
     * Subagents and Background Calls are deliberately not cleared: one the model backgrounded
     * outlives the turn that started it and reports into a later one (ADR 0016, ADR 0021).
     */
    if (event.type === "turn_ended") {
      record.openEnquiryIds.clear();
      record.openPermissionIds.clear();
    }
  }

  /**
   * Stamp `restingAt` when the derived activity *enters* `idle` — the moment this Agent Session
   * came to rest and became something to type at.
   *
   * On the transition rather than on the state, because `onBackendEvent` runs for every streamed
   * token: stamping on the state would restamp continuously and reproduce the `updatedAt` churn
   * this field exists to escape.
   *
   * Awaiting deliberately does not stamp, though it is equally its owner's turn. The rail surfaces
   * it by band now, so a stamp would buy nothing — and it would cost: a turn that hits two
   * un-authorised tools would come back out of Awaiting with a fresh timestamp and jump the running
   * band, which is the churn all of this exists to stop.
   */
  private noteResting(record: SessionRecord, before: SessionStatus): void {
    const after = this.activityOf(record);
    if (after === before) return;
    if (after === "idle") record.restingAt = new Date().toISOString();
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
      titleSource: record.titleSource,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lifecycle: record.lifecycle,
      // Mirrored for a daemon rolled back to before the split, which reads only this. Without it
      // every Settled Agent Session would load as Dormant there and stop being reaped.
      status: record.lifecycle === "live" ? "idle" : record.lifecycle,
      restingAt: record.restingAt,
      ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
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
/**
 * The Enquiries the transcript last saw open.
 *
 * Derived rather than held on the record, for the reason `openSubagents` is derived: an Enquiry
 * belongs to a turn of a Backend Session and the host outlives both, and reading it back from the
 * transcript is what makes the restart path work at all — nothing was in memory.
 *
 * The whole `questions` array comes back with it, because a snapshot carries the whole state and the
 * terminal one the host is about to append needs it again.
 */
function toggle(ids: Set<string>, id: string, open: boolean): void {
  if (open) ids.add(id);
  else ids.delete(id);
}

/**
 * The Lifecycle a persisted Agent Session loads as.
 *
 * Anything that was live becomes Dormant: ADR 0003 drops the turn a restart tore, so there is
 * nothing running to report. `lifecycle` is absent on a meta written before the split, and the
 * deprecated `status` mirror is what stands in — including its own live values, which collapse the
 * same way.
 */
function lifecycleFrom(meta: SessionMeta): SessionLifecycle {
  const stored = meta.lifecycle ?? meta.status;
  return stored === "ended" || stored === "settled" || stored === "dormant" ? stored : "dormant";
}

function openEnquiries(entries: LoggedEvent[]): { askId: string; questions: Question[] }[] {
  const open = new Map<string, Question[]>();
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type !== "enquiry") continue;
    if (event.state === "asked") open.set(event.askId, event.questions);
    else open.delete(event.askId);
  }
  return [...open].map(([askId, questions]) => ({ askId, questions }));
}

/**
 * The Permission Prompts the transcript last saw open.
 *
 * Derived rather than held, for the reason `openEnquiries` is derived: a prompt belongs to a turn of
 * a Backend Session and the host outlives both, and reading it back from the transcript is the only
 * thing that works on the restart path — nothing was in memory to read.
 *
 * The tool name comes back with it, because a snapshot carries the whole state and the terminal one
 * the host is about to append needs it again.
 */
function openPermissions(entries: LoggedEvent[]): { callId: string; tool: string }[] {
  const open = new Map<string, string>();
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type !== "permission") continue;
    if (event.state === "asked") open.set(event.callId, event.tool);
    else open.delete(event.callId);
  }
  return [...open].map(([callId, tool]) => ({ callId, tool }));
}

/**
 * The same scan for Background Calls (ADR 0021).
 *
 * `producer` comes back with the tool name because the terminal snapshot must carry it too: the web
 * client decides from `producer` which surface a card belongs to, so one that dropped it would move
 * the card as it settled.
 */
function openBackgroundCalls(entries: LoggedEvent[]): { callId: string; tool: string; producer?: Producer }[] {
  const open = new Map<string, { tool: string; producer?: Producer }>();
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type !== "background_call") continue;
    if (event.state === "running") {
      open.set(event.callId, { tool: event.tool, ...(event.producer === undefined ? {} : { producer: event.producer }) });
    } else open.delete(event.callId);
  }
  return [...open].map(([callId, brief]) => ({ callId, ...brief }));
}

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
