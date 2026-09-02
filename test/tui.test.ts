import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { PassThrough } from "node:stream";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { connect } from "../src/client/connection.ts";
import { initialState, reduceAll } from "../src/client/reduce.ts";
import { sessionLabel } from "../src/client/session-label.ts";
import { SessionLog } from "../src/daemon/log.ts";
import { effortChoices, modelChoices } from "../src/client/model-choices.ts";
import { renderFrame, type UiState } from "../src/tui/render.ts";
import { KEY } from "../src/tui/keys.ts";
import { runTui } from "../src/tui/app.ts";
import type { Capabilities } from "../src/protocol/events.ts";

const CAPABILITIES: Capabilities = {
  providers: ["anthropic", "openai"],
  models: [
    { id: "claude-opus-5", provider: "anthropic", label: "Opus 5", effortLevels: ["low", "high", "max"] },
    { id: "gpt-x", provider: "openai", label: "GPT X" },
    { id: "claude-sonnet-5", provider: "anthropic", label: "Sonnet 5" },
  ],
  compaction: true,
  fork: false,
};

function baseUi(overrides: Partial<UiState> = {}): UiState {
  return {
    sessions: [
      { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "First", updatedAt: "", lastSeq: 0 },
    ],
    selected: "s1",
    view: { ...initialState(), capabilities: CAPABILITIES },
    input: "",
    overlay: { kind: "none" },
    ...overrides,
  };
}

describe("TUI rendering", () => {
  it("groups models by provider", () => {
    const choices = modelChoices(CAPABILITIES);
    assert.deepEqual(
      choices.map((choice) => `${choice.provider}/${choice.model.id}`),
      ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-x"],
    );
  });

  it("groups Settled Agent Sessions under their own divider, with last-updated badges", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const at = (ms: number): string => new Date(now - ms).toISOString();
    const ui = baseUi({
      overlay: { kind: "sessions", index: 0 },
      now,
      sessions: [
        { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "Live one", updatedAt: at(30_000), lastSeq: 0 },
        { id: "s2", scope: "/tmp", backend: "fake", status: "dormant", title: "Older", updatedAt: at(3 * 3_600_000), lastSeq: 0 },
        { id: "s3", scope: "/tmp", backend: "fake", status: "settled", title: "Filed away", updatedAt: at(5 * 60_000), lastSeq: 0 },
      ],
    });

    const frame = renderFrame(ui, { columns: 80, rows: 14 }).join("\n");
    assert.match(frame, /just now.*Live one/);
    assert.match(frame, /3h.*Older/);
    // The divider sits above the Settled group and below the live ones.
    const dividerAt = frame.indexOf("── settled ──");
    assert.ok(dividerAt > frame.indexOf("Live one"), "divider comes after the live sessions");
    assert.ok(dividerAt < frame.indexOf("Filed away"), "divider comes before the settled ones");
  });

  it("names an Agent Session by its id while it has no title yet", () => {
    // The title is derived from the first message, so an Agent Session nobody has written to has
    // none — and an empty string renders as nothing at all.
    assert.equal(sessionLabel({ id: "s1", title: "" }), "s1");
    const ui = baseUi({
      overlay: { kind: "sessions", index: 0 },
      sessions: [
        { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "", updatedAt: "", lastSeq: 0 },
      ],
    });
    const frame = renderFrame(ui, { columns: 80, rows: 12 });
    assert.match(frame[0] ?? "", /fake · s1/, "the header must name the Agent Session");
    assert.match(frame.join("\n"), /idle {5}fake {4}.*s1/, "so must the list row");
  });

  it("renders a structural marker as a rule rather than as one more notice line", () => {
    const log = new SessionLog("s1");
    log.append({ type: "session_dormant", reason: "host shutdown" }, "2026-01-01T00:00:00Z");
    log.append({ type: "notice", level: "warn", text: "just a message" }, "2026-01-01T00:00:00Z");
    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 60, rows: 12 }).join("\n");
    assert.match(frame, /── Dormant: host shutdown ─+/);
    assert.match(frame, /! just a message/);
  });

  it("renders exactly the terminal height, whatever the content", () => {
    const log = new SessionLog("s1");
    for (let index = 0; index < 50; index += 1) {
      log.append({ type: "message", id: `m${index}`, text: `line ${index}`, final: true }, "2026-01-01T00:00:00Z");
    }
    const ui = baseUi({ view: reduceAll(log.since(0)) });
    for (const rows of [6, 12, 24, 60]) {
      assert.equal(renderFrame(ui, { columns: 60, rows }).length, rows);
    }
  });

  it("never emits a line wider than the terminal", () => {
    const log = new SessionLog("s1");
    log.append({ type: "message", id: "m1", text: "x".repeat(500), final: true }, "2026-01-01T00:00:00Z");
    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 40, rows: 12 });
    for (const line of frame) assert.ok(line.length <= 40, `line too wide: ${line.length}`);
  });

  it("shows the newest output rather than the oldest", () => {
    const log = new SessionLog("s1");
    for (let index = 0; index < 40; index += 1) {
      log.append({ type: "message", id: `m${index}`, text: `line ${index}`, final: true }, "2026-01-01T00:00:00Z");
    }
    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 60, rows: 12 }).join("\n");
    assert.match(frame, /line 39/);
    assert.doesNotMatch(frame, /line 0\b/);
  });

  it("surfaces queue depth, so a queued message is not silently swallowed", () => {
    const ui = baseUi({ view: { ...initialState(), queue: ["a", "b"] } });
    assert.match(renderFrame(ui, { columns: 80, rows: 10 }).join("\n"), /2 queued/);
  });

  it("offers the Effort levels of the model in force, not of the session", () => {
    const view = { ...initialState(), capabilities: CAPABILITIES };
    assert.deepEqual(effortChoices({ ...view, model: { id: "claude-opus-5" } }), ["low", "high", "max"]);
    assert.deepEqual(effortChoices({ ...view, model: { id: "gpt-x" } }), [], "a model without one offers nothing");
  });

  it("marks the Effort in force in the picker, and says so when there is none", () => {
    const view = { ...initialState(), capabilities: CAPABILITIES };
    const chosen = renderFrame(
      baseUi({ view: { ...view, model: { id: "claude-opus-5" }, effort: "high" }, overlay: { kind: "effort", index: 0 } }),
      { columns: 60, rows: 12 },
    ).join("\n");
    assert.match(chosen, /high {2}\(in force\)/);

    const none = renderFrame(
      baseUi({ view: { ...view, model: { id: "gpt-x" } }, overlay: { kind: "effort", index: 0 } }),
      { columns: 60, rows: 12 },
    ).join("\n");
    assert.match(none, /no effort control/);
  });

  it("keeps the selected model in view in a long list", () => {
    const many: Capabilities = {
      ...CAPABILITIES,
      models: Array.from({ length: 300 }, (_, index) => ({
        id: `m${index}`,
        provider: `p${Math.floor(index / 50)}`,
        label: `Model ${index}`,
      })),
    };
    const ui = baseUi({
      view: { ...initialState(), capabilities: many },
      overlay: { kind: "models", index: 250 },
    });
    assert.match(renderFrame(ui, { columns: 60, rows: 16 }).join("\n"), /Model 250/);
  });
});

describe("TUI over the wire", () => {
  let running: RunningServer;
  let backend: FakeBackend;
  let stdin: PassThrough;
  let output: string[];
  let finished: Promise<void>;

  beforeEach(async () => {
    backend = new FakeBackend();
    const host = new SessionHost();
    host.registerBackend(backend);
    running = await serve({ host, token: "test-token" });

    stdin = new PassThrough();
    Object.assign(stdin, { setRawMode: () => undefined, isTTY: true });
    output = [];
    const stdout = Object.assign(new PassThrough(), {
      columns: 80,
      rows: 24,
      write: (chunk: string) => {
        output.push(chunk);
        return true;
      },
    });

    finished = runTui({
      connection: connect({ url: running.url, token: "test-token" }),
      scope: "/tmp/scope",
      backend: "fake",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    await waitFor(() => backend.sessions.length === 1);
  });

  afterEach(async () => {
    stdin.write(KEY.ctrlC);
    await finished;
    await running.close();
  });

  it("creates a session and sends what was typed", async () => {
    stdin.write("hello");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);
    assert.deepEqual(backend.latest.prompts, ["hello"]);
  });

  it("renders assistant output arriving over SSE", async () => {
    stdin.write("hi");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    backend.latest.say("the answer");
    backend.latest.completeTurn();
    await waitFor(() => output.join("").includes("the answer"));
  });

  it("queues a message typed while the agent is working", async () => {
    stdin.write("first");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    stdin.write("second");
    stdin.write(KEY.enter);
    await waitFor(() => output.join("").includes("1 queued"));
    assert.deepEqual(backend.latest.prompts, ["first"], "typing must not interrupt a running turn");

    backend.latest.completeTurn();
    await waitFor(() => backend.latest.prompts.length === 2);
    assert.deepEqual(backend.latest.prompts, ["first", "second"]);
  });

  it("aborts the running turn on escape", async () => {
    stdin.write("work");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    stdin.write(KEY.escape);
    await waitFor(() => output.join("").includes("idle"));
  });

  it("sets Effort from the picker", async () => {
    stdin.write(KEY.ctrlE);
    /*
     * Wait for the *picker* to know the levels, not for the backend to have them.
     *
     * Capabilities reach the TUI late and over SSE — `query()` emits nothing until the input stream
     * yields, so an adapter announces them on the way up rather than at create (see the README).
     * Waiting on `backend.latest.capabilities` therefore proves nothing about this client: until the
     * `capabilities_changed` entry has been reduced, render.ts draws "no effort control", and the
     * two keystrokes below land on an empty list and are silently dropped. That is what made this
     * test fail intermittently, and more often once the embedded manifest grew and slowed startup.
     */
    await waitFor(() => (output.at(-1) ?? "").includes("effort  (enter to set"));

    stdin.write(KEY.down);
    stdin.write(KEY.enter);
    // fake-1 offers low/medium/high; the cursor starts on the level in force and steps down.
    await waitFor(() => backend.latest.effort !== undefined);
    assert.equal(backend.latest.effort, "medium");
  });

  it("settles from the session list without opening the session", async () => {
    const settled = backend.latest;
    stdin.write(KEY.ctrlS);
    await waitFor(() => output.join("").includes("s to settle"));

    stdin.write("s");
    await waitFor(() => settled.disposed);

    // The list stays up: settling is filing something away, not picking what to work on next.
    const frame = output.at(-1) ?? "";
    assert.match(frame, /sessions {2}\(enter to switch/, "the session list is still open");
    assert.match(frame, /settled/);
  });

  it("edits the input line with backspace", async () => {
    stdin.write("helXo");
    stdin.write(KEY.backspace);
    stdin.write(KEY.backspace);
    stdin.write("lo");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);
    assert.deepEqual(backend.latest.prompts, ["hello"]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
