import type { AttachmentMediaType } from "../protocol/attachments.ts";
import type {
  BackendEvent,
  Capabilities,
  EffortLevel,
  PermissionDecision,
  Skill,
  Spend,
} from "../protocol/events.ts";

/**
 * One Attachment's bytes on their way to a model.
 *
 * base64 rather than a path, because neither SDK has a local-path image source — Claude's takes
 * base64, a URL or a Files API id, and pi's takes base64 — so a path would only mean every adapter
 * reading the same file the same way. The Session Host reads it once instead.
 */
export type PromptAttachment = {
  mediaType: AttachmentMediaType;
  /** base64, without a data-URL prefix. */
  data: string;
};

export type BackendCreateOptions = {
  scope: string;
  modelId?: string;
  effort?: EffortLevel;
  /** Resume token from a previous Backend Session, when reviving a Dormant Agent Session. */
  resume?: string;
  /** A directory this adapter may keep its own session state in, beside our transcript. */
  stateDir?: string;
  /**
   * What this Agent Session had already spent before this Backend Session opened.
   *
   * Spend is cumulative for the Agent Session, and a backend can only count its own run: a Revive
   * starts a fresh one, whose counters begin at zero. Without this the meter drops back to what the
   * newest Backend Session has spent, which reads as the bill resetting itself.
   */
  priorSpend?: Spend;
  /**
   * The Standing Authorisations in force when this Backend Session opened — tools to run without
   * raising a Permission Prompt, on top of whatever the adapter pre-approves.
   *
   * A snapshot, deliberately. The Settings have one owner and are read *through* it (ADR 0009), which
   * rejected the observer shape a live-updating list would need; so a grant made in another Agent
   * Session is not pushed here. The cost is one extra prompt in a session that was already running,
   * which then honours it for the rest of its life — and every session started afterwards reads the
   * grant from the Settings.
   */
  standingAuthorisations?: readonly string[];
  emit: (event: BackendEvent) => void;
};

/**
 * One live Backend Session. `prompt` always means "now" — the Steering Queue lives in the Session
 * Host (ADR 0002), so an adapter never queues on the host's behalf.
 */
export interface BackendSession {
  readonly capabilities: Capabilities;
  /** Opaque token allowing a later Revive to continue this Conversation Context. */
  resumeToken(): string | undefined;
  /**
   * `attachments` reach only the model a turn actually runs on. An adapter is handed them without
   * being asked whether it can use them: whether the selected model accepts an image is already
   * declared on `ModelInfo.acceptsImages`, and the host refuses a send that contradicts it, so an
   * adapter that receives them has already been told they are servable.
   */
  prompt(text: string, attachments?: PromptAttachment[]): Promise<void>;
  abort(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  /**
   * Asking for a level the current model does not serve is not an error: the adapter clamps to the
   * nearest one it can serve and reports what it settled on with `effort_changed`.
   */
  setEffort(effort: EffortLevel): Promise<void>;
  /**
   * Compact the Conversation Context now.
   *
   * Optional, and paired with `capabilities.compaction`: an adapter that cannot serve one omits the
   * method and declares `false`, and clients hide the control rather than offering something that
   * breaks. Present-but-declared-false is not a state worth having, so the host checks the flag and
   * never the method.
   *
   * Reports through events like everything else — a `compacted` when it lands, a `notice` when it
   * does not. The promise resolving means the request was made, not that the summary exists.
   *
   * **Opens a turn and closes it**, exactly as `prompt` does: `turn_started` before this returns,
   * `turn_ended` whatever the outcome. A compaction is a model call that runs for minutes, and the
   * Steering Queue orders the messages behind it on that pair alone. An adapter that opens one and
   * never closes it pins the Agent Session in `running` and refuses everything sent afterwards.
   */
  compact?(instructions?: string): Promise<void>;
  /**
   * The Skills this Agent Session's Scope offers.
   *
   * Asked each time rather than cached, because the answer is a directory listing and a human who
   * has just written a Skill expects to find it without restarting anything. An adapter that has no
   * notion of them omits this, and the composer offers none.
   *
   * Only Skills — never the backend's own built-in commands. A CLI's `/model`, `/clear` or `/config`
   * would be a second way to change state the Session Host already owns, able to disagree with it.
   */
  skills?(): Promise<Skill[]>;
  /**
   * Answer an Enquiry this Backend Session is holding open.
   *
   * Optional, and paired with `capabilities.enquiries` exactly as `compact` is paired with
   * `capabilities.compaction`: an adapter with no channel to ask through omits the method and
   * declares `false`, and the host gates on the flag and never on the method.
   *
   * Answers `false` when there is no such open Enquiry — one already answered, one abandoned when a
   * turn was aborted, or an `askId` a client read out of a week-old transcript. Not an error: a stale
   * answer is an ordinary race, and the host turns it into a refusal a human can read.
   *
   * Reports through events like everything else. The terminal `enquiry` snapshot is what a reader
   * sees, and the promise resolving means the answer reached the backend, not that the model has
   * acted on it.
   */
  answerEnquiry?(askId: string, answers: string[][]): Promise<boolean>;
  /**
   * Decide a Permission Prompt this Backend Session is holding open.
   *
   * Optional, and paired with `capabilities.permissions` the way the two methods above are paired
   * with their flags: an adapter that cannot be asked before it acts omits the method and declares
   * `false`. The host gates on the flag and never on the method.
   *
   * Answers `false` when there is no such open prompt — one already decided, one abandoned with a
   * torn turn, or a `callId` a client read out of an old transcript. An ordinary race, and the host
   * turns it into a refusal a human can read. It is also the signal that **nothing must be
   * persisted**: a stale `always` must not leave a Standing Authorisation behind.
   *
   * `always` is honoured *within this Backend Session* by the adapter, which stops asking about the
   * tool. Granting it beyond this session is not the adapter's business — the Settings have one owner
   * (ADR 0009), and it is not a Backend Adapter.
   */
  answerPermission?(callId: string, decision: PermissionDecision): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface AgentBackend {
  readonly name: string;
  create(options: BackendCreateOptions): Promise<BackendSession>;
}
