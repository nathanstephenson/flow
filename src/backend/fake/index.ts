import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendCreateOptions, BackendSession } from "../types.ts";
import type { BackendEvent, Capabilities } from "../../protocol/events.ts";

const FAKE_CAPABILITIES: Capabilities = {
  providers: ["fake"],
  models: [{ id: "fake-1", provider: "fake", label: "Fake 1" }],
  compaction: false,
  fork: false,
};

/**
 * A Backend Adapter with no model behind it, driven entirely by the test.
 *
 * Turns do not end on their own — the test calls `completeTurn()`. That makes queue and lifecycle
 * assertions deterministic instead of timing-dependent.
 */
export class FakeSession implements BackendSession {
  readonly capabilities = FAKE_CAPABILITIES;
  readonly prompts: string[] = [];
  modelId: string;
  disposed = false;

  private readonly emit: (event: BackendEvent) => void;
  private turnId: string | undefined;

  constructor(options: BackendCreateOptions) {
    this.emit = options.emit;
    this.modelId = options.modelId ?? "fake-1";
  }

  resumeToken(): string | undefined {
    return `fake-resume-${this.prompts.length}`;
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
  }

  async abort(): Promise<void> {
    this.completeTurn("aborted");
  }

  async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    this.emit({ type: "model_changed", model: { id: modelId, provider: "fake" } });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  /** Test affordance: emit assistant text for the turn in flight. */
  say(text: string, final = true): void {
    this.emit({ type: "message", id: `msg-${this.prompts.length}`, text, final });
  }

  /** Test affordance: emit a complete tool call. */
  useTool(name: string, input: unknown, result: unknown, isError = false): string {
    const callId = randomUUID();
    this.emit({ type: "tool_started", callId, name, input });
    this.emit({ type: "tool_ended", callId, result, isError });
    return callId;
  }

  /** Test affordance: end the turn in flight. */
  completeTurn(reason: "complete" | "aborted" | "error" = "complete"): void {
    if (!this.turnId) return;
    const turnId = this.turnId;
    this.turnId = undefined;
    this.emit({ type: "turn_ended", turnId, reason });
  }
}

export class FakeBackend implements AgentBackend {
  readonly name = "fake";
  readonly sessions: FakeSession[] = [];

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    const session = new FakeSession(options);
    this.sessions.push(session);
    return session;
  }

  get latest(): FakeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("No fake session created yet");
    return session;
  }
}
