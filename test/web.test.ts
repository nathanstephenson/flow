import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { readFileSync } from "node:fs";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { SessionLog } from "../src/daemon/log.ts";
import { reduceAll } from "../src/client/reduce.ts";
import { editDiff } from "../src/client/diff.ts";
import type { AgentEvent } from "../src/protocol/events.ts";
import { buildAssets } from "../scripts/build-assets.mjs";

const TOKEN = "web-test-token";

describe("web assets", () => {
  let running: RunningServer;

  before(async () => {
    const host = new SessionHost();
    host.registerBackend(new FakeBackend());
    running = await serve({ host, token: TOKEN, scope: "/tmp/scope" });
  });

  after(async () => {
    await running.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${running.url}${path}`, { headers: { cookie: `goodharness=${TOKEN}`, ...headers } });

  it("keeps the generated asset module in step with its sources", () => {
    const onDisk = readFileSync(new URL("../src/web/assets.generated.ts", import.meta.url), "utf8");
    assert.equal(onDisk, buildAssets(), "run `npm run build:assets`");
  });

  it("serves the app shell, styles and script", async () => {
    for (const [path, type] of [
      ["/", "text/html"],
      ["/styles.css", "text/css"],
      ["/app.js", "text/javascript"],
      ["/reduce.js", "text/javascript"],
      ["/diff.js", "text/javascript"],
      ["/relative-time.js", "text/javascript"],
    ] as const) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") ?? "", new RegExp(type));
    }
  });

  it("requires authentication for the UI itself, not just the API", async () => {
    const response = await fetch(`${running.url}/`);
    assert.equal(response.status, 401);
  });

  it("tells a client the default Scope and available backends", async () => {
    const config = (await (await get("/api/config")).json()) as { scope: string; backends: string[] };
    assert.equal(config.scope, "/tmp/scope");
    assert.ok(config.backends.includes("fake"));
  });

  /**
   * The point of the whole arrangement: the browser runs the same reducer as the TUI. Load what the
   * server actually serves and check it produces byte-identical state.
   */
  it("serves a reducer that behaves exactly like the one the TUI uses", async () => {
    const source = await (await get("/reduce.js")).text();
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    )) as typeof import("../src/client/reduce.ts");

    const log = new SessionLog("s1");
    const events: AgentEvent[] = [
      { type: "session_started", backend: "fake", scope: "/tmp", capabilities: { providers: ["fake"], models: [], compaction: false, fork: false } },
      { type: "user_message", id: "u1", text: "hello" },
      { type: "turn_started", turnId: "t1" },
      { type: "message", id: "m1", text: "par", final: false },
      { type: "tool_started", callId: "c1", name: "Edit", input: { file_path: "a.ts" } },
      { type: "message", id: "m1", text: "partial whole", final: true },
      { type: "tool_ended", callId: "c1", result: "ok", isError: false },
      { type: "queue_changed", pending: ["later"] },
      { type: "turn_ended", turnId: "t1", reason: "complete" },
    ];
    for (const event of events) log.append(event, "2026-01-01T00:00:00.000Z");

    assert.deepEqual(module.reduceAll(log.since(0)), reduceAll(log.since(0)));
  });

  it("serves a reducer with no imports, so the browser needs no bundler", async () => {
    const source = await (await get("/reduce.js")).text();
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.match(source, /export function reduce\b/);
  });
});

describe("edit diffs", () => {
  it("reads the shape Claude's Edit tool actually produces", () => {
    // Captured from a real session: {replace_all, file_path, old_string, new_string}.
    const diff = editDiff({
      replace_all: false,
      file_path: "/tmp/gh-demo/greeting.txt",
      old_string: "Hello, world!",
      new_string: "Goodbye, world!",
    });
    assert.deepEqual(diff, {
      path: "/tmp/gh-demo/greeting.txt",
      removed: ["Hello, world!"],
      added: ["Goodbye, world!"],
    });
  });

  it("treats a Write as pure addition", () => {
    assert.deepEqual(editDiff({ file_path: "a.txt", content: "one\ntwo\n" }), {
      path: "a.txt",
      removed: [],
      added: ["one", "two"],
    });
  });

  it("leaves non-editing tools alone", () => {
    assert.equal(editDiff({ file_path: "a.txt" }), undefined);
    assert.equal(editDiff("ls -la"), undefined);
    assert.equal(editDiff(undefined), undefined);
  });
});
