import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendCreateOptions, BackendSession } from "../types.ts";
import type { BackendEvent, Capabilities, EffortLevel } from "../../protocol/events.ts";
import { clampEffort } from "../effort.ts";

// Two models on purpose: one with an effort control and one without, which is the split every
// real backend has (Claude's haiku offers no effort) and the one clients must cope with.
const FAKE_CAPABILITIES: Capabilities = {
  providers: ["fake"],
  models: [
    { id: "fake-1", provider: "fake", label: "Fake 1", effortLevels: ["low", "medium", "high"] },
    { id: "fake-2", provider: "fake", label: "Fake 2" },
  ],
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
  readonly resumedFrom: string | undefined;
  modelId: string;
  effort: EffortLevel | undefined;
  disposed = false;

  private readonly emit: (event: BackendEvent) => void;
  private turnId: string | undefined;
  private wantedEffort: EffortLevel | undefined;

  constructor(options: BackendCreateOptions) {
    this.emit = options.emit;
    this.modelId = options.modelId ?? "fake-1";
    this.resumedFrom = options.resume;
    this.emit({ type: "model_changed", model: { id: this.modelId, provider: "fake" } });
    if (options.effort) void this.setEffort(options.effort);
  }

  resumeToken(): string | undefined {
    return "fake-resume";
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
    if (this.wantedEffort) await this.setEffort(this.wantedEffort);
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.wantedEffort = effort;
    const levels = FAKE_CAPABILITIES.models.find((model) => model.id === this.modelId)?.effortLevels;
    const level = clampEffort(effort, levels);
    if (!level) return;
    this.effort = level;
    this.emit({ type: "effort_changed", effort: level });
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
