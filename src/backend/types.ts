import type { AttachmentMediaType } from "../protocol/attachments.ts";
import type { BackendEvent, Capabilities, EffortLevel, Spend } from "../protocol/events.ts";

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
  dispose(): Promise<void>;
}

export interface AgentBackend {
  readonly name: string;
  create(options: BackendCreateOptions): Promise<BackendSession>;
}
