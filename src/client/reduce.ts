import type {
  AgentEvent,
  Capabilities,
  EffortLevel,
  LoggedEvent,
  ModelInfo,
  NoticeLevel,
  Producer,
  Spend,
  SubagentWait,
} from "../protocol/events.ts";
import type { SessionStatus } from "../protocol/commands.ts";
import type { Branch } from "../protocol/git.ts";

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
    }
  | { kind: "notice"; id: string; level: NoticeLevel; text: string }
  /**
   * Going Dormant, Settling and Reviving are structural facts about an Agent Session's life, not
   * messages about it — ADR 0003 calls a Revive "a visible marker". Collapsing them into `notice`
   * meant the meaning was carried only by a text string, so every front-end had to recover it by
   * sniffing a prefix. Kept distinct, `applyEvent`'s exhaustive switch makes a front-end that has
   * not thought about markers a compile error.
   */
  | { kind: "marker"; id: string; marker: "dormant" | "settled" | "revived"; text: string };

export type ViewState = {
  status: SessionStatus;
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
  endedReason?: string;
  lastSeq: number;
};

export function initialState(): ViewState {
  return { status: "idle", entries: [], queue: [], activeSubagents: 0, lastSeq: 0 };
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
  const next = applyEvent(state, entry.event) as ViewState | undefined;
  if (next === undefined) return { ...state, lastSeq: entry.seq };
  return next === state ? state : { ...next, lastSeq: entry.seq };
}

function applyEvent(state: ViewState, event: AgentEvent): ViewState {
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
        entries: upsert(state.entries, {
          kind: "user",
          id: event.id,
          text: event.text,
          ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
        }),
      };

    case "turn_started":
      return { ...state, status: "running" };

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
        }),
      };
    }

    case "turn_ended":
      return { ...state, status: "idle" };

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

    case "session_dormant":
      return {
        ...state,
        status: "dormant",
        queue: [],
        entries: [
          ...state.entries,
          { kind: "marker", id: `dormant-${state.entries.length}`, marker: "dormant", text: `Dormant: ${event.reason}` },
        ],
      };

    case "session_settled":
      return {
        ...state,
        status: "settled",
        queue: [],
        entries: [
          ...state.entries,
          { kind: "marker", id: `settled-${state.entries.length}`, marker: "settled", text: "Settled" },
        ],
      };

    case "revived":
      return {
        ...state,
        status: "idle",
        entries: [
          ...state.entries,
          { kind: "marker", id: `revived-${event.fromSeq}`, marker: "revived", text: `Revived from seq ${event.fromSeq}` },
        ],
      };

    case "session_ended":
      return { ...state, status: "ended", endedReason: event.reason };
  }
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
