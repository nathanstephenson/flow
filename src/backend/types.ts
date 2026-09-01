import type { BackendEvent, Capabilities, EffortLevel } from "../protocol/events.ts";

export type BackendCreateOptions = {
  scope: string;
  modelId?: string;
  effort?: EffortLevel;
  /** Resume token from a previous Backend Session, when reviving a Dormant Agent Session. */
  resume?: string;
  /** A directory this adapter may keep its own session state in, beside our transcript. */
  stateDir?: string;
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
  prompt(text: string): Promise<void>;
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
