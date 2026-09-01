import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { PassThrough } from "node:stream";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { connect } from "../src/client/connection.ts";
import { initialState, reduceAll } from "../src/client/reduce.ts";
import { SessionLog } from "../src/daemon/log.ts";
import { modelChoices, renderFrame, type UiState } from "../src/tui/render.ts";
import { KEY } from "../src/tui/keys.ts";
import { runTui } from "../src/tui/app.ts";
import type { Capabilities } from "../src/protocol/events.ts";

const CAPABILITIES: Capabilities = {
  providers: ["anthropic", "openai"],
  models: [
    { id: "claude-opus-5", provider: "anthropic", label: "Opus 5" },
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
