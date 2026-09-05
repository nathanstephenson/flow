import type { Branch } from "./git.ts";

/**
 * The Agent Event union — the product boundary. Everything a client renders arrives as one of
 * these, from every Backend Adapter, over the wire.
 *
 * Events are upsert-by-id snapshots, not deltas: `message` and `thinking` carry the whole
 * accumulated text so far, replacing any earlier event with the same id. pi emits snapshots
 * natively and Claude emits per-message objects plus deltas, so snapshots are the shape both can
 * produce losslessly. Deriving deltas from pi's snapshots would need prefix-diffing.
 */

/**
 * How hard a model is asked to think on a turn. The union of both SDKs' vocabularies — Claude
 * offers low through max, pi offers off through xhigh — with no invented equivalences between
 * them: a model declares only the levels it actually serves.
 */
export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelInfo = {
  id: string;
  provider?: string;
  label?: string;
  /**
   * Effort levels this model serves. Absent or empty means it has no effort control — Claude's
   * haiku reports none — and clients hide the control rather than offering a setting that does
   * nothing. Effort lives on the model rather than on Capabilities because that is where both
   * SDKs put it: Claude reports it per entry from `supportedModels()`, and pi's available thinking
   * levels follow whichever model is selected.
   */
  effortLevels?: EffortLevel[];
  /**
   * Set when this model can be shown an Attachment.
   *
   * On the model rather than on Capabilities for the reason `effortLevels` is: it is where both SDKs
   * put it. pi's model registry declares `input: ("text" | "image")[]` per entry, so a session that
   * can see an image on one model cannot on the next — a per-session flag would start lying the
   * moment someone switched. Claude's `supportedModels()` reports no such field because every model
   * it serves can, which its adapter states outright the way it already states `providers`.
   *
   * Absent means a client refuses a paste rather than offering one the turn would fail on.
   */
  acceptsImages?: true;
};

/**
 * What a Backend Adapter can be asked to do, declared per Agent Session. Clients hide controls a
 * backend cannot serve rather than breaking on them. `providers` is what distinguishes the two
 * backends in practice: Claude reports one, pi reports several.
 */
export type Capabilities = {
  providers: string[];
  models: ModelInfo[];
  compaction: boolean;
  fork: boolean;
  /**
   * Set when this Backend Adapter reports Delegations. False is not "this backend has no subagents"
   * but "this backend does not tell us about them" — the distinction `effortLevels` draws for a
   * model with no Effort. A client hides the affordance rather than showing an empty tree.
   */
  delegation: boolean;
};

/**
 * What one model cost an Agent Session so far. A Delegation runs under its own entry, which is the
 * only place its tokens are reported at all.
 *
 * `id` is the model as a reader would name it (`claude-haiku-4-5`), not the versioned key the
 * backend arrived at it by. `cached` is the read-from-cache share of `tokens` — billed, but at a
 * fraction of the rate, and on a long session the majority of the count.
 */
export type ModelSpend = { id: string; tokens: number; cached: number; costUSD: number };

/**
 * Everything billed for an Agent Session so far.
 *
 * Cumulative, not per-turn: the backend reports a running total, so a client replaces this reading
 * rather than adding to it. `tokens` and `cached` are sums over `models`, carried rather than
 * derived so a client that shows only the total does not have to know how to add one up.
 */
export type Spend = { tokens: number; cached: number; costUSD: number; models: ModelSpend[] };

export type TurnEndReason = "complete" | "aborted" | "error";

/**
 * Who produced an event within a turn.
 *
 * Absent means the Agent Session's own model, which is the overwhelmingly common case and the reason
 * this is optional rather than a required `"self" | Delegation`: every event written before this
 * existed reduces identically, so no Presentation Transcript needs migrating — and ADR 0001 forbids
 * rewriting one anyway.
 *
 * `delegationId` is the callId of the tool call that spawned the Delegation (ADR 0015), so this and
 * the `tool` Entry a reader can already see address the same thing.
 */
export type Producer = { delegationId: string };

/** What a waiting Delegation is waiting on. A variant, so the type refuses a wait with no object. */
export type DelegationWait =
  /** The Provider is not answering — a rate limit, or a retry in flight. */
  | "provider"
  /** A Delegation of its own has not come back. */
  | "child"
  /** A human has not yet answered a Permission Prompt. */
  | "permission";

/**
 * A Delegation's whole state, as a snapshot (ADR 0015).
 *
 * The terminal states reuse TurnEndReason's three words verbatim: a Delegation ends the way a turn
 * does, and inventing a second vocabulary for the same three outcomes is how two front-ends drift.
 */
export type DelegationState =
  | { state: "running" }
  | { state: "waiting"; on: DelegationWait }
  | { state: TurnEndReason };

export type NoticeLevel = "info" | "warn" | "error";

export type AgentEvent =
  /**
   * `worktree` is set when the Scope is one the Session Host cut, rather than a directory its owner
   * named. Reported here as well as on `SessionSummary` — the same two channels `capabilities`
   * uses, and for the same reason: a client reducing a transcript needs it without asking, and one
   * listing sessions needs it without subscribing. Both are `record.worktree`, so they cannot
   * disagree.
   */
  | {
      type: "session_started";
      backend: string;
      scope: string;
      capabilities: Capabilities;
      worktree?: true;
    }
  | { type: "capabilities_changed"; capabilities: Capabilities }
  /**
   * `attachments` are ids, never bytes. A Presentation Transcript is read in full on every load and
   * replayed on every Revive (ADR 0001), so a line of it carrying megabytes of base64 would make the
   * record unreadable and unbounded — the bytes live beside it and are fetched when shown.
   */
  | { type: "user_message"; id: string; text: string; attachments?: string[] }
  | { type: "turn_started"; turnId: string }
  /**
   * `producer` on these five is what attributes a Delegation's work to it (ADR 0015). Absent means
   * the Agent Session's own model. Deliberately not on `turn_started`/`turn_ended` — a Delegation is
   * not a turn and does not end one — nor on `notice`, which is GoodHarness talking, not a model.
   */
  | { type: "message"; id: string; text: string; final: boolean; producer?: Producer }
  | { type: "thinking"; id: string; text: string; final: boolean; producer?: Producer }
  | { type: "tool_started"; callId: string; name: string; input: unknown; producer?: Producer }
  | { type: "tool_updated"; callId: string; update: unknown; producer?: Producer }
  | { type: "tool_ended"; callId: string; result: unknown; isError: boolean; producer?: Producer }
  /**
   * One Delegation, wholly (ADR 0015). `delegationId` is the callId of the spawning tool call, so
   * this and the `tool_started` beside it address the same thing.
   *
   * `name` is the subagent's declared identity where a backend reports one and the tool name where
   * it does not, so a client always has something to print. `description` is the brief it was given.
   *
   * Repeated on every transition, latest-wins — never a started/ended pair, so a client joining at
   * `since: N` holds a lifecycle it can complete.
   */
  | ({ type: "delegation"; delegationId: string; name: string; description?: string } & DelegationState)
  | { type: "turn_ended"; turnId: string; reason: TurnEndReason }
  | { type: "queue_changed"; pending: string[] }
  /**
   * `used`/`window` are occupancy: how full the Conversation Context is, and so what the next turn
   * has room to do. `spend` is a different measure — everything billed for this Agent Session so
   * far, across every model, **including Delegations**, whose own conversations never enter the
   * Conversation Context and so are invisible to `used`.
   *
   * Optional because only a backend that reports per-model usage can supply it.
   */
  | { type: "context_usage"; used: number; window: number; spend?: Spend }
  | { type: "model_changed"; model: ModelInfo }
  | { type: "effort_changed"; effort: EffortLevel }
  | { type: "branch_changed"; branch: Branch }
  | { type: "notice"; level: NoticeLevel; text: string }
  | { type: "session_dormant"; reason: string }
  | { type: "session_settled" }
  | { type: "revived"; fromSeq: number }
  | { type: "session_ended"; reason: string };

export type AgentEventType = AgentEvent["type"];

/**
 * Events the Session Host owns and a Backend Adapter must never emit. The queue lives above the
 * backend (ADR 0002), the host records what the human sent, revival is a host concern, and the
 * branch is moved by the host on the Scope — no SDK is told, and none could report it truthfully.
 *
 * A value rather than only a type, because the conformance suite needs the same list at runtime.
 * It used to hand-copy it and had already fallen a member behind (`session_dormant`), which is a
 * gap that widens silently every time this union grows: the type would refuse an adapter emitting
 * one of these, and the suite would not notice an adapter that did.
 */
export const HOST_OWNED_EVENT_TYPES = [
  "user_message",
  "queue_changed",
  "revived",
  "session_dormant",
  "session_settled",
  "session_ended",
  "branch_changed",
] as const;

export type HostOwnedEventType = (typeof HOST_OWNED_EVENT_TYPES)[number];

export type BackendEvent = Exclude<AgentEvent, { type: HostOwnedEventType }>;

/** An Agent Event as stored in a Presentation Transcript: ordered, addressable, replayable. */
export type LoggedEvent = {
  seq: number;
  sessionId: string;
  at: string;
  event: AgentEvent;
};
