import type {
  AgentEvent,
  Capabilities,
  EffortLevel,
  LoggedEvent,
  ModelInfo,
  NoticeLevel,
  Producer,
  Question,
  Spend,
  SubagentWait,
} from "../protocol/events.ts";
import type { SessionLifecycle, SessionStatus } from "../protocol/commands.ts";
import type { Branch } from "../protocol/git.ts";
import { compactTokens } from "./context-usage.ts";
import { deriveStatus } from "./status.ts";

/**
 * The reducer both front-ends share. The TUI and the web UI import this same function, which is
 * what stops them drifting.
 *
 * Pure and order-dependent only on `seq`: replaying a Presentation Transcript twice gives the same
 * state, and a client joining at `since: N` converges with one that saw everything.
 */

export type ToolStatus = "running" | "complete" | "error";

/** Flattened from SubagentState, so an Entry stays a flat record like every other one. */
export type SubagentStatus = "running" | "waiting" | "complete" | "aborted" | "error";

/** Flattened from EnquiryState, for the reason SubagentStatus is flattened from SubagentState. */
export type EnquiryStatus = "asked" | "answered" | "aborted";

/**
 * The Enquiry blocking this turn: what is being asked, and the id to answer it under.
 *
 * The whole thing rather than an id, because it reaches the web client's Chrome and the composer is
 * handed Chrome and nothing else — a component fetching the body out of the transcript when it could
 * have been handed it is a second data channel for one object.
 *
 * That is safe on a shallow-compared snapshot only because of how it is maintained: `reduce` mints
 * this once, when the Enquiry is first asked, and carries the *same reference* through every
 * streamed frame until something terminal drops it. What `activeSubagents` refuses is a value
 * rebuilt per tick, which could never compare equal to the one before it; this is the opposite, and
 * it holds the same contract `model` and `capabilities` already do.
 */
export type OpenEnquiry = { askId: string; questions: Question[] };

/** Flattened from PermissionState, for the reason EnquiryStatus is flattened from EnquiryState. */
export type Authorisation = "asked" | "allowed" | "always" | "denied";

/**
 * The Permission Prompt blocking this turn: which tool wants to run, and the id to decide it under.
 *
 * The whole thing rather than an id, for the reason `OpenEnquiry` is whole — the composer is handed
 * Chrome and nothing else. Which is *all* it is: what the call would do reads off the `tool` Entry
 * this shares an id with, and `toolSummary` already turns that into a line both front-ends print.
 *
 * Maintained under the same contract as `asking`, and it has to be: minted once when the prompt is
 * first raised and then held by reference, so a repeated `asked` snapshot cannot republish a
 * shallow-compared chrome.
 */
export type OpenPermission = { callId: string; tool: string };

export type Entry =
  /** `attachments` are ids; a front-end fetches the bytes from the Session Host to show them. */
  | { kind: "user"; id: string; text: string; attachments?: string[] }
  | { kind: "assistant"; id: string; text: string; final: boolean; producer?: Producer }
  | { kind: "thinking"; id: string; text: string; final: boolean; producer?: Producer }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      update?: unknown;
      result?: unknown;
      status: ToolStatus;
      /**
       * What a human decided about this call, where they were asked at all (ADR 0018).
       *
       * **Absent is the common case and means nobody was asked** — the tool was pre-approved or
       * carried a Standing Authorisation. It is not "denied", and a front-end must not render it as
       * a decision: most rows in most transcripts have none.
       *
       * Folded onto this Entry rather than given one of its own, which is the whole shape of the
       * feature in the reducer. A Permission Prompt is *about* this call and shares its id, and the
       * row a reader needs is the one already naming the tool and précising its arguments — a second
       * row would print `WebFetch https://…` and then `Permission: allowed` underneath it. The
       * alternative was an Entry kind that suppressed this one, the way an Enquiry's does, at the
       * cost of a case in four exhaustive switches to say less.
       *
       * `status` stays what the *call* did, and the two are independent readings: a denied call ends
       * `error`, because it did (the model got a refusal it can read), and an allowed one that then
       * failed says so too. Neither can be derived from the other.
       */
      authorisation?: Authorisation;
      producer?: Producer;
    }
  /**
   * One Subagent (ADR 0015). `id` is the spawning tool call's id, so this Entry and the `tool`
   * Entry beside it are two views of one thing: the tool row is what the parent asked for, and this
   * is what the subagent is doing about it. Two Entries rather than fields on one because `upsert`
   * is keyed on kind and id, and the two arrive from different events at different rates.
   */
  | {
      kind: "subagent";
      id: string;
      name: string;
      description?: string;
      status: SubagentStatus;
      waitingOn?: SubagentWait;
      producer?: Producer;
      /**
       * When the Subagent was first reported, and when it stopped.
       *
       * The only Entry carrying time, and deliberately so: a Subagent is the one thing here a
       * reader watches rather than reads, so how long it has been going is part of its state. Every
       * other Entry's moment is its position in the transcript.
       *
       * Taken from the event's own `at`, which the store otherwise discards. `startedAt` survives
       * every later snapshot — upsert replaces the Entry wholesale, so it has to be carried forward
       * explicitly or each snapshot would reset the clock.
       */
      startedAt: string;
      /** Absent while it is still working. Set once, by the snapshot that ends it. */
      endedAt?: string;
    }
  /**
   * One Enquiry: every Question one `AskUserQuestion` call asked, and what came of them.
   *
   * `id` is the `askId`, which is the asking tool call's id — so this Entry and the `tool` Entry
   * beside it are two views of one thing, as a Subagent's two are (ADR 0015). The front-ends show
   * this one and suppress that one, for the reason `subagent-rows.ts` already gives: the two are
   * adjacent, carry the same brief, and only one of them carries a status.
   *
   * `answers` comes off the Enquiry's own snapshot rather than the tool result, because the SDK's
   * result is prose — *"The user answered: "…"="zod""* — and a front-end reading that would be
   * parsing an English sentence to find out what its own user clicked.
   *
   * No timestamps, unlike `subagent`. A Subagent is watched because it progresses; an Enquiry does
   * not — it is open or it is not, and how long it has been open changes nothing a reader can do
   * about it. Its moment is its position in the transcript, like every other Entry's.
   */
  | {
      kind: "enquiry";
      id: string;
      questions: Question[];
      status: EnquiryStatus;
      /** Present only on `answered`, index-aligned with `questions`. */
      answers?: string[][];
      producer?: Producer;
    }
  | { kind: "notice"; id: string; level: NoticeLevel; text: string }
  /**
   * Going Dormant, Settling and Reviving are structural facts about an Agent Session's life, not
   * messages about it — ADR 0003 calls a Revive "a visible marker". Collapsing them into `notice`
   * meant the meaning was carried only by a text string, so every front-end had to recover it by
   * sniffing a prefix. Kept distinct, `applyEvent`'s exhaustive switch makes a front-end that has
   * not thought about markers a compile error.
   *
   * Compaction joins them for the same reason and one more: it is the only one of the four that is
   * a fact about the Conversation Context rather than the Agent Session, and a reader needs to tell
   * "the model was given a summary of what it had read" apart from "this session stopped".
   */
  | { kind: "marker"; id: string; marker: "dormant" | "settled" | "revived" | "compacted"; text: string };

export type ViewState = {
  /**
   * Derived, never assigned by an arm — `reduce` works it out from the three fields below through
   * the same `deriveStatus` the Session Host calls.
   *
   * Held on the state rather than computed by every reader because the web client's Chrome is
   * compared per key by identity, and a getter would be a fresh value each time.
   */
  status: SessionStatus;
  /** This reducer's mirror of `SessionRecord.lifecycle`. Not on the Chrome. */
  lifecycle: SessionLifecycle;
  /** This reducer's mirror of `SessionRecord.turnInFlight`. Not on the Chrome. */
  turnInFlight: boolean;
  backend?: string;
  scope?: string;
  capabilities?: Capabilities;
  model?: ModelInfo;
  effort?: EffortLevel;
  /** Absent when the Scope is not a repository, which is how a front-end hides the control. */
  branch?: Branch;
  /**
   * Set when the Scope is a worktree the Session Host made.
   *
   * Carried so a front-end can name the Project: a worktree Scope ends `<repo>/<branch>`, and one
   * showing only the last segment would name the branch and drop the repository.
   */
  worktree?: true;
  entries: Entry[];
  queue: string[];
  contextUsage?: { used: number; window: number; spend?: Spend };
  /**
   * Subagents running or waiting right now.
   *
   * Carried rather than derived because the front-ends need it per frame while a subagent streams,
   * and counting it from `entries` there would be a scan of the whole transcript on every tick. Kept
   * current in `case "subagent"` instead, which runs a few times a turn.
   *
   * A number, not a list: it reaches the web client's Chrome, which is shallow-compared by identity,
   * so a fresh array would defeat the suppression that keeps a streaming snapshot from re-rendering
   * the chrome. See `sameChrome` in web/src/store/agent-session-view.ts.
   */
  activeSubagents: number;
  /**
   * The Enquiry blocking this turn, or absent.
   *
   * Drives the lockout: while this is set the composer may only answer it, in both front-ends. So
   * **everything that ends a turn or a Backend Session clears it** — not only the Enquiry's own
   * terminal snapshot, but `turn_ended`, `session_dormant`, `session_settled` and `session_ended`
   * too. A torn turn that left this set would lock the composer with no key that unlocks it, which
   * is the one failure of this feature a human could not recover from without reloading.
   */
  /*
   * `| undefined` explicitly, unlike every other optional here, because this one is *cleared* on
   * five different paths and `exactOptionalPropertyTypes` refuses an assigned `undefined` otherwise.
   * The alternative is an `omitAsking` helper beside `omitCompacting` called from all five — more
   * ceremony than the distinction earns, since nothing reads "absent" differently from "undefined".
   */
  asking?: OpenEnquiry | undefined;
  /**
   * The Permission Prompt blocking this turn, or absent.
   *
   * Drives the same lockout `asking` does and is cleared by the same five paths, for the same reason:
   * a prompt left set over a torn turn locks the composer on buttons that settle nothing.
   *
   * **The oldest open one, not a list.** One assistant message can carry several tool calls, so
   * several prompts can be open at once — they are decided oldest-first, and deciding one promotes
   * the next. Kept as a single value rather than a queue because this reaches a chrome compared by
   * identity per key: an array rebuilt on each arrival could never compare equal, and would
   * re-render the chrome on every streamed token. That is what `activeSubagents` is a number to
   * avoid. Held `undefined` rather than empty for the same reason, so a session that never sees a
   * prompt never republishes on the five clearing paths either.
   */
  authorising?: OpenPermission | undefined;
  /**
   * Set while the backend is summarising the Conversation Context.
   *
   * A boolean rather than a count: two compactions cannot overlap, because the host refuses a
   * second one while a turn is in flight and a compaction is not a turn to queue behind.
   */
  compacting?: true;
  /**
   * Whether anybody has said anything yet.
   *
   * A boolean rather than a count, and set rather than derived from `entries`, for the reason
   * `activeSubagents` is a number: it reaches the web client's Chrome, which is shallow-compared,
   * so scanning `entries` in `chromeOf` would be work on every streamed frame to answer a question
   * that changes exactly once in a session's life.
   *
   * What it is for is the Rename item in the pane's overflow menu: a Summary Model cannot name a
   * session with nothing in it, and the front-ends hide what cannot apply rather than offering
   * something that comes back as a refusal.
   */
  spoken?: true;
  endedReason?: string;
  lastSeq: number;
};

export function initialState(): ViewState {
  return {
    status: "idle",
    lifecycle: "live",
    turnInFlight: false,
    entries: [],
    queue: [],
    activeSubagents: 0,
    lastSeq: 0,
  };
}

/** Running and waiting are both live work; the three terminal states are not. */
function isActive(status: SubagentStatus): boolean {
  return status === "running" || status === "waiting";
}

export function reduceAll(entries: Iterable<LoggedEvent>, from: ViewState = initialState()): ViewState {
  let state = from;
  for (const entry of entries) state = reduce(state, entry);
  return state;
}

export function reduce(state: ViewState, entry: LoggedEvent): ViewState {
  /*
   * The cast is deliberate. `applyEvent`'s switch is exhaustive over `AgentEvent` and has no
   * `default` arm, which is what makes a new event type a compile error in every front-end — the
   * property the Entry union's comment relies on, and worth keeping.
   *
   * But a Presentation Transcript is durable and replayed in full forever (ADR 0001), so at runtime
   * it can hold an event *this build* has never heard of: one written before a rename, or by a newer
   * daemon against an older client. Such an event falls through the switch and `applyEvent` returns
   * undefined — and spreading that replaced the entire view with `{ lastSeq }`. No status, no
   * entries, no scope: one unrecognised line silently emptied a session.
   *
   * `lastSeq` still advances, because the event *was* consumed. Only its meaning is unavailable.
   */
  const next = applyEvent(state, entry.event, entry.at) as ViewState | undefined;
  if (next === undefined) return { ...state, lastSeq: entry.seq };
  if (next === state) return state;
  /*
   * Derived here rather than in the arms, through the function the Session Host also calls, so the
   * rail and the pane cannot disagree about what a session is doing. They used to be two switch
   * statements maintained by hand, which is what let the rail say settled while the pane said idle.
   */
  return {
    ...next,
    status: deriveStatus({
      lifecycle: next.lifecycle,
      turnInFlight: next.turnInFlight,
      awaiting: next.asking !== undefined || next.authorising !== undefined,
    }),
    lastSeq: entry.seq,
  };
}

function applyEvent(state: ViewState, event: AgentEvent, at: string): ViewState {
  switch (event.type) {
    case "session_started":
      return {
        ...state,
        backend: event.backend,
        scope: event.scope,
        capabilities: event.capabilities,
        ...(event.worktree === undefined ? {} : { worktree: event.worktree }),
      };

    case "capabilities_changed":
      return { ...state, capabilities: event.capabilities };

    case "user_message":
      return {
        ...state,
        spoken: true,
        entries: upsert(state.entries, {
          kind: "user",
          id: event.id,
          text: event.text,
          ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
        }),
      };

    case "turn_started":
      return { ...state, turnInFlight: true };

    case "message":
      return {
        ...state,
        entries: upsert(state.entries, {
          kind: "assistant",
          id: event.id,
          text: event.text,
          final: event.final,
          ...producerOf(event),
        }),
      };

    case "thinking":
      return {
        ...state,
        entries: upsert(state.entries, {
          kind: "thinking",
          id: event.id,
          text: event.text,
          final: event.final,
          ...producerOf(event),
        }),
      };

    case "tool_started":
      return {
        ...state,
        entries: upsert(state.entries, {
          kind: "tool",
          id: event.callId,
          name: event.name,
          input: event.input,
          status: "running",
          ...producerOf(event),
        }),
      };

    case "tool_updated":
      return { ...state, entries: patchTool(state.entries, event.callId, (tool) => ({ ...tool, update: event.update })) };

    case "tool_ended":
      return {
        ...state,
        entries: patchTool(state.entries, event.callId, (tool) => ({
          ...tool,
          result: event.result,
          status: event.isError ? "error" : "complete",
        })),
      };

    case "subagent": {
      // Snapshots repeat, so the count moves on the *transition* rather than on each arrival: a
      // Subagent reporting `running` twice must not count twice.
      const previous = state.entries.find(
        (entry): entry is Extract<Entry, { kind: "subagent" }> =>
          entry.kind === "subagent" && entry.id === event.subagentId,
      );
      const wasActive = previous !== undefined && isActive(previous.status);
      const nowActive = isActive(event.state);
      // Carried forward, not re-read: a running Subagent reports repeatedly, and taking `at` each
      // time would keep resetting when it started. Cleared if it somehow resumes, so a live
      // Subagent never shows an end.
      const endedAt = nowActive ? undefined : (previous?.endedAt ?? at);
      return {
        ...state,
        activeSubagents: state.activeSubagents + (nowActive ? 1 : 0) - (wasActive ? 1 : 0),
        entries: upsert(state.entries, {
          kind: "subagent",
          id: event.subagentId,
          name: event.name,
          ...(event.description === undefined ? {} : { description: event.description }),
          status: event.state,
          // Only ever set alongside "waiting", so a Subagent that resumes drops it rather than
          // carrying a stale object it is no longer waiting on.
          ...(event.state === "waiting" ? { waitingOn: event.on } : {}),
          startedAt: previous?.startedAt ?? at,
          ...(endedAt === undefined ? {} : { endedAt }),
        }),
      };
    }

    case "enquiry": {
      const open = event.state === "asked";
      /*
       * Minted once and then held by reference, which is what makes it safe on a shallow-compared
       * snapshot: a repeated `asked` snapshot must not produce a fresh object, or the web client's
       * chrome would republish on every one. Compared on the id rather than deep-equality because
       * the id is what identifies an Enquiry and its questions cannot change under it.
       */
      const asking =
        open && state.asking?.askId === event.askId
          ? state.asking
          : open
            ? { askId: event.askId, questions: event.questions }
            : state.asking?.askId === event.askId
              ? undefined
              : state.asking;

      return {
        ...state,
        ...(asking === undefined ? { asking: undefined } : { asking }),
        entries: upsert(state.entries, {
          kind: "enquiry",
          id: event.askId,
          questions: event.questions,
          status: event.state,
          ...(event.state === "answered" ? { answers: event.answers } : {}),
          ...(event.producer === undefined ? {} : { producer: event.producer }),
        }),
      };
    }

    case "permission": {
      const open = event.state === "asked";
      /*
       * Held by reference exactly as `asking` is, and for the same reason — a repeated `asked`
       * snapshot must not mint a fresh object, or the web client's chrome republishes on each one.
       *
       * The difference is the promotion. Several prompts can be open at once, so a decision on the
       * one in hand hands over to the next still-open call rather than clearing outright: `entries`
       * is scanned for a `tool` row still `asked`, which is the transcript's own record of what is
       * waiting. That scan runs a few times a turn, not per frame. A prompt arriving while another is
       * in hand changes nothing here — it is already in `entries`, and will be promoted in its turn.
       */
      const authorising = open
        ? (state.authorising ?? { callId: event.callId, tool: event.tool })
        : state.authorising?.callId === event.callId
          ? nextAwaiting(state.entries, event.callId)
          : state.authorising;

      return {
        ...state,
        ...(authorising === undefined ? { authorising: undefined } : { authorising }),
        entries: patchTool(state.entries, event.callId, (tool) => ({
          ...tool,
          authorisation: authorisationOf(event),
        })),
      };
    }

    case "turn_ended":
      // `asking` and `authorising` cleared here as well as on their own terminal snapshots. A backend
      // that tore down without emitting one would otherwise leave the composer locked out for good —
      // see ViewState.asking. Clearing twice costs nothing; clearing never is unrecoverable.
      return { ...state, turnInFlight: false, asking: undefined, authorising: undefined };

    case "queue_changed":
      return { ...state, queue: [...event.pending] };

    case "context_usage":
      return {
        ...state,
        contextUsage: {
          used: event.used,
          window: event.window,
          ...(event.spend === undefined ? {} : { spend: event.spend }),
        },
      };

    case "model_changed":
      return { ...state, model: event.model };

    case "effort_changed":
      return { ...state, effort: event.effort };

    case "branch_changed":
      return { ...state, branch: event.branch };

    case "notice":
      return {
        ...state,
        entries: [...state.entries, { kind: "notice", id: `notice-${state.entries.length}`, level: event.level, text: event.text }],
      };

    case "compacting":
      // Absent rather than `false`, so Chrome's identity comparison sees the same value it saw
      // before a compaction as after one, rather than a new object every time this arrives.
      return event.active ? { ...state, compacting: true } : omitCompacting(state);

    case "compacted":
      return {
        ...omitCompacting(state),
        entries: [
          ...state.entries,
          {
            kind: "marker",
            id: `compacted-${state.entries.length}`,
            marker: "compacted",
            text: compactedLabel(event.trigger, event.before, event.after),
          },
        ],
      };

    case "session_dormant":
      return {
        ...state,
        lifecycle: "dormant",
        turnInFlight: false,
        queue: [],
        // Neither an Enquiry nor a Permission Prompt can survive its Backend Session: the promise a
        // human would have settled died with it. Same for the two below.
        asking: undefined,
        authorising: undefined,
        entries: [
          ...state.entries,
          { kind: "marker", id: `dormant-${state.entries.length}`, marker: "dormant", text: `Dormant: ${event.reason}` },
        ],
      };

    case "session_settled":
      return {
        ...state,
        lifecycle: "settled",
        turnInFlight: false,
        queue: [],
        asking: undefined,
        authorising: undefined,
        entries: [
          ...state.entries,
          { kind: "marker", id: `settled-${state.entries.length}`, marker: "settled", text: "Settled" },
        ],
      };

    case "revived":
      return {
        ...state,
        lifecycle: "live",
        turnInFlight: false,
        entries: [
          ...state.entries,
          { kind: "marker", id: `revived-${event.fromSeq}`, marker: "revived", text: `Revived from seq ${event.fromSeq}` },
        ],
      };

    case "session_ended":
      return {
        ...state,
        lifecycle: "ended",
        turnInFlight: false,
        endedReason: event.reason,
        asking: undefined,
        authorising: undefined,
      };
  }
}

/**
 * `compacting` dropped, without leaving an explicit `undefined` behind for the spread to carry.
 *
 * `compacted` clears it as well as `compacting: false` does: a backend that reports the boundary but
 * never says it stopped would otherwise leave the chrome saying so forever.
 */
function omitCompacting(state: ViewState): ViewState {
  if (!state.compacting) return state;
  const { compacting: _dropped, ...rest } = state;
  return rest;
}

/**
 * What a compaction marker says.
 *
 * The before-and-after is the whole point of showing it: "Compacted" alone tells a reader something
 * happened without telling them what it bought, and the number they are watching — occupancy — is
 * about to drop for a reason nothing else in the transcript explains. A backend that does not report
 * what it ended at gets the honest half rather than a fabricated arrow.
 *
 * Automatic is the case that needs naming, because it is the one nobody asked for.
 */
function compactedLabel(trigger: "auto" | "manual", before: number, after: number | undefined): string {
  const how = trigger === "auto" ? "Compacted automatically" : "Compacted";
  if (after === undefined) return `${how}, from ${compactTokens(before)} tokens`;
  return `${how}, ${compactTokens(before)} → ${compactTokens(after)} tokens`;
}

/**
 * One `permission` snapshot as the word that goes on the tool row.
 *
 * `always` is kept apart from `allow` rather than flattened to it, because they are not the same
 * thing to a reader scrolling back: one authorised a call, the other authorised every call of that
 * tool on this machine, and only the transcript ever says which click did that.
 */
function authorisationOf(event: Extract<AgentEvent, { type: "permission" }>): Authorisation {
  if (event.state === "asked") return "asked";
  // An abandoned prompt *is* a refusal, and the model was told so — see `abandonAll` in the adapter.
  // Recording it as anything softer would leave a row saying "waiting" over a session that has gone.
  if (event.state === "aborted") return "denied";
  return event.decision === "deny" ? "denied" : event.decision === "always" ? "always" : "allowed";
}

/**
 * The next call still waiting to be authorised, once the one in hand is decided.
 *
 * Read off `entries` rather than tracked, because the transcript is already the record of what is
 * open: a `tool` row still marked `asked` is a prompt nobody has answered. `except` is the call just
 * decided, whose own patch has not been applied yet at the point this runs.
 *
 * Returns the *first* such row, so prompts are decided oldest-first — which is the order they were
 * raised in and the order a human works through them.
 */
function nextAwaiting(entries: Entry[], except: string): OpenPermission | undefined {
  const next = entries.find(
    (entry) => entry.kind === "tool" && entry.id !== except && entry.authorisation === "asked",
  );
  return next?.kind === "tool" ? { callId: next.id, tool: next.name } : undefined;
}

/** Spread onto an Entry, so an unattributed event does not carry an explicit `producer: undefined`. */
function producerOf(event: { producer?: Producer }): { producer?: Producer } {
  return event.producer === undefined ? {} : { producer: event.producer };
}

/** Upsert by id — the snapshot semantics the event union is built on. */
function upsert(entries: Entry[], entry: Entry): Entry[] {
  const index = entries.findIndex((candidate) => candidate.kind === entry.kind && candidate.id === entry.id);
  if (index < 0) return [...entries, entry];
  const copy = [...entries];
  copy[index] = entry;
  return copy;
}

function patchTool(
  entries: Entry[],
  callId: string,
  patch: (tool: Extract<Entry, { kind: "tool" }>) => Entry,
): Entry[] {
  const index = entries.findIndex((candidate) => candidate.kind === "tool" && candidate.id === callId);
  if (index < 0) return entries;
  const existing = entries[index];
  if (!existing || existing.kind !== "tool") return entries;
  const copy = [...entries];
  copy[index] = patch(existing);
  return copy;
}
