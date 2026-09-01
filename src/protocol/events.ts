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
};

export type TurnEndReason = "complete" | "aborted" | "error";

export type NoticeLevel = "info" | "warn" | "error";

export type AgentEvent =
  | { type: "session_started"; backend: string; scope: string; capabilities: Capabilities }
  | { type: "capabilities_changed"; capabilities: Capabilities }
  | { type: "user_message"; id: string; text: string }
  | { type: "turn_started"; turnId: string }
  | { type: "message"; id: string; text: string; final: boolean }
  | { type: "thinking"; id: string; text: string; final: boolean }
  | { type: "tool_started"; callId: string; name: string; input: unknown }
  | { type: "tool_updated"; callId: string; update: unknown }
  | { type: "tool_ended"; callId: string; result: unknown; isError: boolean }
  | { type: "turn_ended"; turnId: string; reason: TurnEndReason }
  | { type: "queue_changed"; pending: string[] }
  | { type: "context_usage"; used: number; window: number }
  | { type: "model_changed"; model: ModelInfo }
  | { type: "effort_changed"; effort: EffortLevel }
  | { type: "notice"; level: NoticeLevel; text: string }
  | { type: "session_dormant"; reason: string }
  | { type: "session_settled" }
  | { type: "revived"; fromSeq: number }
  | { type: "session_ended"; reason: string };

export type AgentEventType = AgentEvent["type"];

/**
 * Events the Session Host owns and a Backend Adapter must never emit. The queue lives above the
 * backend (ADR 0002), the host records what the human sent, and revival is a host concern.
 */
export type HostOwnedEventType =
  | "user_message"
  | "queue_changed"
  | "revived"
  | "session_dormant"
  | "session_settled"
  | "session_ended";

export type BackendEvent = Exclude<AgentEvent, { type: HostOwnedEventType }>;

/** An Agent Event as stored in a Presentation Transcript: ordered, addressable, replayable. */
export type LoggedEvent = {
  seq: number;
  sessionId: string;
  at: string;
  event: AgentEvent;
};
