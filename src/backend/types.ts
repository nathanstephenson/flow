import type { BackendEvent, Capabilities } from "../protocol/events.ts";

export type BackendCreateOptions = {
  scope: string;
  modelId?: string;
  /** Resume token from a previous Backend Session, when reviving a Dormant Agent Session. */
  resume?: string;
  /** Drop a turn left torn by an unclean shutdown (ADR 0003). */
  dropTornTurn?: boolean;
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
  dispose(): Promise<void>;
}

export interface AgentBackend {
  readonly name: string;
  create(options: BackendCreateOptions): Promise<BackendSession>;
}
