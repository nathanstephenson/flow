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
  compactions: Array<string | undefined>;
  failCompaction: (reason: string) => void;
  aborted: number;
  thinkingLevel: string | undefined;
};

function stubSession(): Stub {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const prompts: Array<{ text: string; options: unknown }> = [];
  const compactions: Array<string | undefined> = [];
  const state = { aborted: 0, compactFails: undefined as string | undefined };
  // m1 reasons across three levels and can be shown an image, m2 does neither — the split every
  // real registry has, on both axes.
  const models = [
    {
      id: "m1",
      provider: "anthropic",
      name: "M1",
      reasoning: true,
      thinkingLevelMap: { low: "l", medium: "m", high: "h" },
      input: ["text", "image"],
    },
    { id: "m2", provider: "anthropic", name: "M2", reasoning: false, input: ["text"] },
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
    // pi resolves this only when the summary exists, so it stays pending unless a test says
    // otherwise — which is what a real compaction looks like from the adapter's side.
    compact(instructions?: string) {
      compactions.push(instructions);
      return state.compactFails
        ? Promise.reject(new Error(state.compactFails))
        : new Promise<void>(() => {});
    },
    async setModel(model: { id: string }) {
      current = models.find((candidate) => candidate.id === model.id) ?? current;
      // pi clamps its own thinking level when the new model cannot serve the old one.
      if (current?.reasoning !== true) thinkingLevel = undefined;
    },
    getContextUsage: () => ({ tokens: 42, contextWindow: 200_000, percent: 0.02 }),
    modelRuntime: {
      getModels: () => [...models, { id: "locked", provider: "unauthenticated" }],
      getAvailable: async () => models,
      getAvailableSnapshot: () => models,
    },
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
    compactions,
    failCompaction: (reason: string) => {
      state.compactFails = reason;
    },
    get aborted() {
      return state.aborted;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
  };
}

it("offers only authenticated models with provider-qualified identity", () => {
  const stub = stubSession();
  const session = new PiSession(stub.session, () => {});
  assert.deepEqual(session.capabilities.models.map((model) => model.id), ["anthropic/m1", "anthropic/m2"]);
  assert.deepEqual(session.capabilities.providers, ["anthropic"]);
});

it("selects the requested Provider and refuses ambiguous legacy ids", async () => {
  const stub = stubSession();
  const models = [
    { id: "shared", provider: "one", reasoning: false },
    { id: "shared", provider: "two", reasoning: false },
  ];
  let chosen: unknown;
  const sdk = {
    ...stub.session,
    modelRuntime: { getAvailable: async () => models, getAvailableSnapshot: () => models },
    setModel: async (model: unknown) => { chosen = model; },
  } as unknown as AgentSession;
  const session = new PiSession(sdk, () => {});
  await session.setModel("two/shared");
  assert.equal(chosen, models[1]);
  await assert.rejects(session.setModel("shared"), /Unknown model/);
});

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

/**
 * Compaction is the one thing a backend does to the Conversation Context that a reader would
 * otherwise only infer from occupancy falling. pi reports it as a start/end pair with three reasons
 * and four ways of not having happened, and all of them arrive on the same event.
 */
describe("pi compaction", () => {
  let stub: Stub;
  let events: BackendEvent[];
  let session: PiSession;

  beforeEach(() => {
    stub = stubSession();
    events = [];
    session = new PiSession(stub.session, (event) => events.push(event));
    void session;
  });

  const ended = (over: Record<string, unknown>) =>
    stub.fire({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { summary: "…", firstKeptEntryId: "e7", tokensBefore: 84_000 },
      ...over,
    } as unknown as AgentSessionEvent);

  const compactions = () => events.filter((event) => event.type === "compacted");

  it("reports what it started from, and does not invent what it ended at", () => {
    ended({});
    assert.deepEqual(compactions(), [{ type: "compacted", trigger: "auto", before: 84_000 }]);
  });

  // pi's three reasons collapse to two triggers: only one of them is somebody asking.
  it("calls a threshold and an overflow automatic, and only manual manual", () => {
    ended({ reason: "threshold" });
    ended({ reason: "overflow" });
    ended({ reason: "manual" });

    assert.deepEqual(
      compactions().map((event) => (event.type === "compacted" ? event.trigger : "")),
      ["auto", "auto", "manual"],
    );
  });

  it("says nothing about a compaction that aborted", () => {
    ended({ aborted: true });
    assert.deepEqual(compactions(), []);
  });

  // The same rule agent_end applies: pi is about to go again, so nothing has happened yet.
  it("waits while pi intends to retry", () => {
    ended({ willRetry: true });
    assert.deepEqual(compactions(), []);

    ended({});
    assert.equal(compactions().length, 1);
  });

  it("raises a failure as a notice and no marker", () => {
    ended({ errorMessage: "context window exhausted", result: undefined });

    assert.deepEqual(compactions(), []);
    assert.deepEqual(
      events.filter((event) => event.type === "notice"),
      [{ type: "notice", level: "error", text: "context window exhausted" }],
    );
  });

  /*
   * The start says a compaction is *happening*; the end says one *happened*. Only the second is a
   * transcript row, which is what keeps one compaction to one row in both backends — the Claude
   * adapter has only a boundary to report.
   */
  it("announces a compaction as state, and records it as a row only when it ends", () => {
    stub.fire({ type: "compaction_start", reason: "threshold" } as unknown as AgentSessionEvent);

    assert.deepEqual(events, [{ type: "compacting", active: true }]);
    assert.deepEqual(compactions(), [], "starting is not a row");

    ended({});
    assert.deepEqual(
      events.map((event) => event.type),
      ["compacting", "compacting", "compacted"],
    );
  });

  /*
   * A requested compaction occupies the session; one pi started for itself does not.
   *
   * That asymmetry is the whole reason `compactionTurnId` exists. pi compacts on its own initiative
   * mid-turn, so opening a turn on `compaction_start` would open a second one inside a turn already
   * running — and closing one on `compaction_end` would end the *real* turn early, returning the
   * session to idle while the model was still working.
   */
  describe("the turn a requested compaction occupies", () => {
    const turns = () => events.filter((event) => event.type === "turn_started" || event.type === "turn_ended");

    it("opens on the request and closes when pi reports the end", async () => {
      await session.compact("keep the API decisions");

      assert.deepEqual(stub.compactions, ["keep the API decisions"]);
      assert.deepEqual(turns().map((event) => event.type), ["turn_started"], "still running");

      ended({ reason: "manual" });
      assert.deepEqual(turns().map((event) => event.type), ["turn_started", "turn_ended"]);
    });

    // The marker has to land inside the turn: turn_ended is what returns the session to idle and
    // lets the Steering Queue drain, so anything after it belongs to whatever comes next.
    it("records the compaction before it gives the session back", async () => {
      await session.compact();
      ended({ reason: "manual" });

      const order = events.map((event) => event.type);
      assert.ok(order.indexOf("compacted") < order.indexOf("turn_ended"));
    });

    it("opens no turn for a compaction pi started itself", () => {
      stub.fire({ type: "compaction_start", reason: "threshold" } as unknown as AgentSessionEvent);
      ended({ reason: "threshold" });

      assert.deepEqual(turns(), [], "an automatic compaction runs inside the turn that provoked it");
    });

    // A turn left open pins the session in `running` forever, refusing every later send.
    it("gives the session back when pi rejects the request outright", async () => {
      stub.failCompaction("no provider configured");
      await session.compact();
      await Promise.resolve();

      assert.deepEqual(turns().map((event) => event.type), ["turn_started", "turn_ended"]);
      assert.deepEqual(
        events.filter((event) => event.type === "notice"),
        [{ type: "notice", level: "error", text: "no provider configured" }],
      );
    });

    // pi is about to go again, so the session is still occupied.
    it("holds the turn open while pi intends to retry", async () => {
      await session.compact();
      ended({ willRetry: true });

      assert.deepEqual(turns().map((event) => event.type), ["turn_started"]);
    });
  });

  // Otherwise the meter pulses until the session is disposed.
  it("stops saying it is working even when nothing was compacted", () => {
    for (const outcome of [{ aborted: true }, { willRetry: true }, { errorMessage: "boom", result: undefined }]) {
      events.length = 0;
      ended(outcome);
      assert.deepEqual(
        events.filter((event) => event.type === "compacting"),
        [{ type: "compacting", active: false }],
      );
      assert.deepEqual(compactions(), []);
    }
  });
});

/**
 * What effort a session reports when nobody has chosen one.
 *
 * The bug this closes: effort was only ever announced when it was *set*, so a new Agent Session that
 * nobody had touched reported none — and the composer's picker fell back to showing its own name
 * while the backend was in fact running at a real level the whole time.
 */
describe("the effort a pi session starts on", () => {
  let stub: Stub;
  let events: BackendEvent[];

  beforeEach(() => {
    stub = stubSession();
    events = [];
  });

  it("announces the thinking level pi is already on", () => {
    const session = new PiSession(stub.session, (event) => events.push(event));
    session.noteStartingEffort();

    assert.deepEqual(
      events.filter((event) => event.type === "effort_changed"),
      [{ type: "effort_changed", effort: "medium" }],
    );
  });

  it("says nothing twice, so a second look is not a second event", () => {
    const session = new PiSession(stub.session, (event) => events.push(event));
    session.noteStartingEffort();
    session.noteStartingEffort();

    assert.equal(events.filter((event) => event.type === "effort_changed").length, 1);
  });

  // m2 does not reason, so pi clears its own thinking level. There is nothing to report, and the
  // composer hides the control for such a model anyway.
  it("says nothing at all when the model in force has no levels", async () => {
    const session = new PiSession(stub.session, (event) => events.push(event));
    await session.setModel("m2");
    events.length = 0;

    session.noteStartingEffort();
    assert.deepEqual(events.filter((event) => event.type === "effort_changed"), []);
  });
});
