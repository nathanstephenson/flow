import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { PiSession } from "../../src/backend/pi/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

/**
 * pi's event vocabulary translated into Agent Events, without a model behind it.
 *
 * These are the mappings that are easy to get wrong and impossible to notice later: run-vs-turn,
 * retry, and the queue behaviour ADR 0002 depends on.
 */

type Stub = {
  session: AgentSession;
  fire: (event: AgentSessionEvent) => void;
  prompts: Array<{ text: string; options: unknown }>;
  aborted: number;
  thinkingLevel: string | undefined;
};

function stubSession(): Stub {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const prompts: Array<{ text: string; options: unknown }> = [];
  const state = { aborted: 0 };
  // m1 reasons across three levels, m2 not at all — the split every real registry has.
  const models = [
    { id: "m1", provider: "anthropic", name: "M1", reasoning: true, thinkingLevelMap: { low: "l", medium: "m", high: "h" } },
    { id: "m2", provider: "anthropic", name: "M2", reasoning: false },
  ];
  let current = models[0];
  let thinkingLevel: string | undefined = "medium";

  const session = {
    subscribe(next: (event: AgentSessionEvent) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    dispose() {},
    async prompt(text: string, options: unknown) {
      prompts.push({ text, options });
    },
    async abort() {
      state.aborted += 1;
    },
    async setModel(model: { id: string }) {
      current = models.find((candidate) => candidate.id === model.id) ?? current;
      // pi clamps its own thinking level when the new model cannot serve the old one.
      if (current?.reasoning !== true) thinkingLevel = undefined;
    },
    getContextUsage: () => ({ tokens: 42, contextWindow: 200_000, percent: 0.02 }),
    modelRegistry: { getAll: () => models },
    get model() {
      return current;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    supportsThinking: () => current?.reasoning === true,
    getAvailableThinkingLevels: () => (current?.reasoning === true ? ["low", "medium", "high"] : []),
  } as unknown as AgentSession;

  return {
    session,
    fire: (event) => listener?.(event),
    prompts,
    get aborted() {
      return state.aborted;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
  };
}

const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as Extract<
    AgentSessionEvent,
    { type: "message_start" }
  >["message"];

describe("pi adapter mapping", () => {
  let stub: Stub;
  let events: BackendEvent[];
  let session: PiSession;

  beforeEach(() => {
    stub = stubSession();
    events = [];
    session = new PiSession(stub.session, (event) => events.push(event));
  });

  it("always steers, never uses pi's native follow-up queue (ADR 0002)", async () => {
    await session.prompt("hello");
    assert.deepEqual(stub.prompts[0]?.options, { streamingBehavior: "steer" });
  });

  it("ignores pi's per-model-call turn events", async () => {
    await session.prompt("hello");
    events.length = 0;

    stub.fire({ type: "turn_start" } as AgentSessionEvent);
    stub.fire({ type: "turn_end", message: assistant("x"), toolResults: [] } as unknown as AgentSessionEvent);

    assert.deepEqual(events, [], "one prompt is one turn, however many model calls it takes");
  });

  it("ends the turn on agent_end, not on turn_end", async () => {
    await session.prompt("hello");
    stub.fire({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);

    const ended = events.filter((event) => event.type === "turn_ended");
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.type === "turn_ended" ? ended[0].reason : "", "complete");
  });

  it("does not end the turn while pi intends to retry", async () => {
    await session.prompt("hello");
    stub.fire({ type: "agent_end", messages: [], willRetry: true } as unknown as AgentSessionEvent);
    assert.equal(events.filter((event) => event.type === "turn_ended").length, 0);

    stub.fire({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);
    assert.equal(events.filter((event) => event.type === "turn_ended").length, 1);
  });

  it("reports an aborted turn after abort()", async () => {
    await session.prompt("hello");
    await session.abort();
    stub.fire({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);

    const ended = events.find((event) => event.type === "turn_ended");
    assert.equal(ended?.type === "turn_ended" ? ended.reason : "", "aborted");
    assert.equal(stub.aborted, 1);
  });

  it("emits assistant text as growing snapshots under one id", async () => {
    await session.prompt("hello");
    stub.fire({ type: "message_start", message: assistant("par") } as unknown as AgentSessionEvent);
    stub.fire({ type: "message_update", message: assistant("partial") } as unknown as AgentSessionEvent);
    stub.fire({ type: "message_end", message: assistant("partial whole") } as unknown as AgentSessionEvent);

    const messages = events.filter((event) => event.type === "message");
    assert.equal(new Set(messages.map((event) => (event.type === "message" ? event.id : ""))).size, 1);
    assert.deepEqual(
      messages.map((event) => (event.type === "message" ? [event.text, event.final] : [])),
      [["par", false], ["partial", false], ["partial whole", true]],
    );
  });

  it("maps pi's tool field names onto the Agent Event union", async () => {
    stub.fire({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a.ts" },
    } as unknown as AgentSessionEvent);
    stub.fire({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: "contents",
      isError: false,
    } as unknown as AgentSessionEvent);

    assert.deepEqual(events, [
      { type: "tool_started", callId: "call-1", name: "read", input: { path: "a.ts" } },
      { type: "tool_ended", callId: "call-1", result: "contents", isError: false },
    ]);
  });

  it("surfaces auto-retry as a notice", async () => {
    stub.fire({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 100,
      errorMessage: "overloaded",
    } as unknown as AgentSessionEvent);

    const notice = events.find((event) => event.type === "notice");
    assert.equal(notice?.type === "notice" ? notice.level : "", "warn");
  });

  it("reports context usage when the run ends", async () => {
    await session.prompt("hello");
    stub.fire({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);

    const usage = events.find((event) => event.type === "context_usage");
    assert.deepEqual(usage?.type === "context_usage" ? [usage.used, usage.window] : [], [42, 200_000]);
  });

  it("declares every provider pi can reach", () => {
    assert.deepEqual(session.capabilities.providers, ["anthropic"]);
    assert.equal(session.capabilities.models[0]?.label, "M1");
  });

  it("declares pi's thinking levels as Effort, per model", () => {
    assert.deepEqual(session.capabilities.models[0]?.effortLevels, ["low", "medium", "high"]);
    assert.equal(session.capabilities.models[1]?.effortLevels, undefined, "a model that cannot reason offers none");
  });

  it("sets Effort as a thinking level and reports what stuck", async () => {
    await session.setEffort("high");
    assert.equal(stub.thinkingLevel, "high");
    assert.deepEqual(effortEvents(), ["high"]);
  });

  it("clamps Effort pi cannot serve rather than failing", async () => {
    // pi has no `max`; the nearest it offers is `high`.
    await session.setEffort("max");
    assert.equal(stub.thinkingLevel, "high");
    assert.deepEqual(effortEvents(), ["high"]);
  });

  it("follows the model when a switch takes the chosen Effort away", async () => {
    await session.setEffort("high");
    events.length = 0;
    await session.setModel("m2");

    assert.equal(stub.thinkingLevel, undefined, "pi dropped the level; the adapter must not force it back");
    assert.deepEqual(effortEvents(), [], "a model with no effort control has no level to report");
    assert.equal(
      events.find((event) => event.type === "capabilities_changed")?.type,
      "capabilities_changed",
      "the levels on offer changed, so clients must be told",
    );
  });

  it("restores the chosen Effort on returning to a model that serves it", async () => {
    await session.setEffort("high");
    await session.setModel("m2");
    events.length = 0;
    await session.setModel("m1");

    assert.equal(stub.thinkingLevel, "high");
    assert.deepEqual(effortEvents(), ["high"]);
  });

  function effortEvents(): string[] {
    return events.filter((event) => event.type === "effort_changed").map((event) => event.effort);
  }
});
