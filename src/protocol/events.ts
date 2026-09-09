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
 * One Skill: a named prompt a backend expands when a message begins with it.
 *
 * A fact about the Scope, not about the Agent Session, which is why it is fetched rather than
 * carried on `Capabilities` or written into a transcript. The list is read from disk — a `skills/`
 * directory, a `.claude/commands` file — and is stale the moment someone edits one, so a copy
 * embedded in an append-only record would be wrong forever and wrong for every session at once.
 *
 * `argumentHint` is the backend's own summary of what may follow the name. Optional because most
 * take nothing, and an empty string is not the same as no hint at all.
 */
export type Skill = {
  name: string;
  description: string;
  argumentHint?: string;
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
   * Set when this Backend Adapter reports Subagents. False is not "this backend has no subagents"
   * but "this backend does not tell us about them" — the distinction `effortLevels` draws for a
   * model with no Effort. A client hides the affordance rather than showing an empty tree.
   */
  subagents: boolean;
  /**
   * Set when this Backend Adapter can carry an Enquiry to a human and an answer back. False is not
   * "this backend's models never ask" but "this backend has no channel to ask through" — the same
   * distinction `subagents` draws, and pi is the case: its `tools` option is a filter over its own
   * built-ins, not a place to register one of ours. A client hides the affordance rather than
   * rendering a question nothing can answer.
   */
  enquiries: boolean;
};

/**
 * What one model cost an Agent Session so far. A Subagent runs under its own entry, which is the
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
 * this is optional rather than a required `"self" | Subagent`: every event written before this
 * existed reduces identically, so no Presentation Transcript needs migrating — and ADR 0001 forbids
 * rewriting one anyway.
 *
 * `subagentId` is the callId of the tool call that spawned the Subagent (ADR 0015), so this and
 * the `tool` Entry a reader can already see address the same thing.
 */
export type Producer = { subagentId: string };

/** What a waiting Subagent is waiting on. A variant, so the type refuses a wait with no object. */
export type SubagentWait =
  /** The Provider is not answering — a rate limit, or a retry in flight. */
  | "provider"
  /** A Subagent of its own has not come back. */
  | "child"
  /** A human has not yet answered a Permission Prompt. */
  | "permission";

/**
 * A Subagent's whole state, as a snapshot (ADR 0015).
 *
 * The terminal states reuse TurnEndReason's three words verbatim: a Subagent ends the way a turn
 * does, and inventing a second vocabulary for the same three outcomes is how two front-ends drift.
 */
export type SubagentState =
  | { state: "running" }
  | { state: "waiting"; on: SubagentWait }
  | { state: TurnEndReason };

/**
 * One choice offered for a Question.
 *
 * `label` is what the choice is and `description` is why someone would pick it; both are the model's
 * own words. `preview` is carried because the tool's schema has it and a transcript is durable, but
 * nothing renders it yet: across every run of `spikes/ask-user-question.ts` the model populated
 * `label` and `description` and nothing else, so its shape is still unobserved rather than known.
 */
export type QuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

/**
 * One of an Enquiry's questions, as the tool call posed it.
 *
 * `header` names the decision in a word or two and `question` is the sentence asked. Both are
 * carried because neither is derived from the other: a picker shows the sentence, and a progress row
 * with four sentences in it is unreadable.
 *
 * `multiSelect` is honoured rather than flattened. A model that asked for several answers and got one
 * back would act on a constraint the human never agreed to.
 */
export type Question = {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

/**
 * What became of an Enquiry. A variant rather than a status beside a nullable `answers`, so the type
 * refuses an answered Enquiry with nothing in it and an open one carrying answers.
 *
 * `aborted` reuses TurnEndReason's word verbatim, as SubagentState does: an Enquiry ends the way a
 * turn does when the work stops and nobody can say what the human would have chosen. There is no
 * `error` — an Enquiry that fails is a turn that failed, and is reported as one.
 *
 * `answers` is index-aligned with `questions`, one entry per Question. The inner array is the labels
 * chosen — one for a single-select, several for a multiSelect — or the human's own words where they
 * typed instead of choosing. Free text is deliberately not marked as such: the Options are in this
 * same snapshot, so a reader that wants to know whether an answer was one of the offered ones can
 * see for itself, and a flag would be a second source of truth about it.
 */
export type EnquiryState =
  | { state: "asked" }
  | { state: "answered"; answers: string[][] }
  | { state: "aborted" };

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
   * `producer` on these five is what attributes a Subagent's work to it (ADR 0015). Absent means
   * the Agent Session's own model. Deliberately not on `turn_started`/`turn_ended` — a Subagent is
   * not a turn and does not end one — nor on `notice`, which is GoodHarness talking, not a model.
   */
  | { type: "message"; id: string; text: string; final: boolean; producer?: Producer }
  | { type: "thinking"; id: string; text: string; final: boolean; producer?: Producer }
  | { type: "tool_started"; callId: string; name: string; input: unknown; producer?: Producer }
  | { type: "tool_updated"; callId: string; update: unknown; producer?: Producer }
  | { type: "tool_ended"; callId: string; result: unknown; isError: boolean; producer?: Producer }
  /**
   * One Subagent, wholly (ADR 0015). `subagentId` is the callId of the spawning tool call, so
   * this and the `tool_started` beside it address the same thing.
   *
   * `name` is the subagent's declared identity where a backend reports one and the tool name where
   * it does not, so a client always has something to print. `description` is the brief it was given.
   *
   * Repeated on every transition, latest-wins — never a started/ended pair, so a client joining at
   * `since: N` holds a lifecycle it can complete.
   */
  | ({ type: "subagent"; subagentId: string; name: string; description?: string } & SubagentState)
  /**
   * One Enquiry, wholly — every Question of one `AskUserQuestion` call and what came of them.
   *
   * `askId` is the callId of the tool call that asked, so this and the `tool` Entry beside it address
   * the same thing: the rule ADR 0015 sets for a Subagent, and available here for the same reason.
   * `spikes/ask-user-question.ts` confirmed the SDK supplies it, and that the assistant message
   * carrying the `tool_use` block lands *before* the permission callback — so the call is already in
   * the transcript by the time this is emitted.
   *
   * Repeated on every transition, latest-wins — never an asked/answered pair, so a client joining at
   * `since: N` holds a lifecycle it can complete, and one replaying a week-old transcript never
   * offers an answer box for a promise that died with its Backend Session.
   *
   * The answers are carried **here** rather than read back off the `tool_ended`, and that is not a
   * convenience. The SDK's tool result is prose — *"The user answered: "…"="zod", …"* — so the
   * structure is gone by the time it returns, and a front-end rendering an answered Enquiry from the
   * tool call alone would be parsing an English sentence to find out what its own user clicked.
   *
   * `producer` is here for the reason `SubagentWait`'s `"permission"` is (ADR 0015): a Subagent can
   * ask, and a second breaking change to a shipped protocol for a case we already expect is the worse
   * trade. Populated only where the SDK attributes the callback, which for a Subagent it has not yet
   * been observed to do.
   */
  | ({ type: "enquiry"; askId: string; questions: Question[]; producer?: Producer } & EnquiryState)
  | { type: "turn_ended"; turnId: string; reason: TurnEndReason }
  | { type: "queue_changed"; pending: string[] }
  /**
   * `used`/`window` are occupancy: how full the Conversation Context is, and so what the next turn
   * has room to do. `spend` is a different measure — everything billed for this Agent Session so
   * far, across every model, **including Subagents**, whose own conversations never enter the
   * Conversation Context and so are invisible to `used`.
   *
   * Optional because only a backend that reports per-model usage can supply it.
   */
  | { type: "context_usage"; used: number; window: number; spend?: Spend }
  /**
   * The Conversation Context was compacted — the backend replaced part of what the model can see
   * with a summary of it.
   *
   * Not host-owned: compaction is the backend's, and GoodHarness only reports it (ADR 0001 —
   * `Conversation Context` is "compacted and owned by the backend"). Nothing here touches the
   * Presentation Transcript, which is why this is the only trace of it a reader ever gets. Until
   * this event existed the whole thing happened invisibly, and a session's `used` would simply fall
   * by two thirds between one turn and the next with nothing to explain it.
   *
   * `trigger` separates the compaction a backend ran on its own from one a human asked for, because
   * they answer different questions: automatic means the window filled up, manual means somebody
   * decided it should. `after` is optional because a backend that reports the boundary need not
   * report what it cost — pi says only that it finished.
   */
  | { type: "compacted"; trigger: "auto" | "manual"; before: number; after?: number }
  /**
   * A compaction is in flight, or has stopped being.
   *
   * Separate from `compacted` because they answer different questions and arrive at different times.
   * `compacted` is the record of one that landed, and it is a row a reader can scroll back to.
   * This is a state that lasts while the backend summarises — which is a model call, and long enough
   * that without it someone who asked for a compaction watches nothing happen and asks again.
   *
   * Not a row, then, and never rendered as one: it drives the chrome, the way `queue_changed` does.
   * `active: false` arrives whatever the outcome, including one that failed or compacted nothing,
   * because the alternative is a spinner nobody can stop.
   *
   * Each backend reports what it can see. pi announces its own compactions before they start, so it
   * says so for automatic ones too; the Claude SDK reports only the boundary after the fact, so
   * there it means "a human asked for this and it has not come back yet".
   */
  | { type: "compacting"; active: boolean }
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
