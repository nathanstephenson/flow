import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { BackendSession, WorkflowSubagentOptions } from "../../src/backend/types.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { piFixture, until, userText } from "./pi-fixture.ts";

// Unlike the injected worker contract tests, this starts the installed Pi SDK in another process.
test("Pi worker executes SDK tools, reports a durable resume token and revives Conversation Context", { timeout: 30_000 }, async (t) => {
  const f = await piFixture(t, (request) => {
    if (userText(request) === "write marker" && !request.messages.some((message) => message.role === "tool")) {
      return { tools: [{ id: "write-marker", name: "write", arguments: { path: "marker.txt", content: "from worker" } }] };
    }
    return { text: "worker answer" };
  });
  const backend = new WorkerBackend({ env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1" } });
  const events: BackendEvent[] = [];
  let session: BackendSession | undefined;
  try {
    session = await backend.create({ scope: f.scope, stateDir: join(f.scope, "worker-state"), modelId: "flow-test/parent", emit: (event) => events.push(event) });
    await session.prompt("write marker");
    await until(() => events.some((event) => event.type === "turn_ended"));
    assert.ok(events.some((event) => event.type === "tool_ended"));
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(f.scope, "marker.txt"), "utf8"), "from worker");
    const resume = session.resumeToken();
    assert.ok(resume);
    await session.dispose();
    session = await backend.create({ scope: f.scope, stateDir: join(f.scope, "worker-state"), resume, modelId: "flow-test/parent", emit: (event) => events.push(event) });
    const before = events.filter((event) => event.type === "turn_ended").length;
    await session.prompt("remember marker");
    await until(() => events.filter((event) => event.type === "turn_ended").length > before);
    assert.ok(JSON.stringify(f.requests.at(-1)?.messages).includes("write marker"));
  } finally {
    await session?.dispose();
  }
});

test("Pi worker preserves foreground Subagent attribution and background completion turns", { timeout: 30_000 }, async (t) => {
  const f = await piFixture(t, (request) => {
    if (userText(request) === "Child instructions") return { text: "Child result" };
    if (request.messages.at(-1)?.role === "user" && userText(request) === "Subagent") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { prompt: "Child instructions", description: "Review", model: "flow-test/child", effort: "high", run_in_background: false },
    }] };
    if (request.messages.at(-1)?.role === "user" && userText(request) === "Background") return { tools: [{
      id: "bash-1", name: "bash", arguments: { command: "while [ ! -f release ]; do sleep 0.01; done; printf finished", timeout: 5, run_in_background: true },
    }] };
    return { text: "Parent response" };
  });
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({ env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1" } }).create({ scope: f.scope, stateDir: join(f.scope, "worker-state"), modelId: "flow-test/parent", emit: (event) => events.push(event) });
  try {
    await session.prompt("Subagent");
    assert.deepEqual(events.filter((event) => event.type === "subagent").map((event) => [event.subagentId, event.state]), [["spawn-1", "running"], ["spawn-1", "complete"]]);
    assert.ok(events.some((event) => event.type === "message" && event.text === "Child result" && event.producer?.subagentId === "spawn-1"));
    assert.equal(f.requests.find((request) => request.model === "child")?.reasoning_effort, "high");
    await session.prompt("Background");
    assert.deepEqual(events.filter((event) => event.type === "background_call").map((event) => event.state), ["running"]);
    const turns = events.filter((event) => event.type === "turn_ended").length;
    writeFileSync(join(f.scope, "release"), "");
    await until(() => events.filter((event) => event.type === "turn_ended").length > turns);
    assert.deepEqual(events.filter((event) => event.type === "background_call").map((event) => event.state), ["running", "complete"]);
  } finally { await session.dispose(); }
});

test("Pi worker owns Workflow Subagent handles without occupying the parent turn", { timeout: 30_000 }, async (t) => {
  const f = await piFixture(t, (request) => ({ text: request.model === "child" ? '{"ok":true}' : "Parent response" }));
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({ env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1" } }).create({ scope: f.scope, stateDir: join(f.scope, "worker-state"), modelId: "flow-test/parent", emit: (event) => events.push(event) });
  try {
    const handle = session.startWorkflowSubagent!({ id: "step-attempt", name: "Review", instructions: "Return JSON", input: {}, modelId: "flow-test/child", effort: "high", permissionMode: "auto-accept", emit: (event) => activity.push(event) });
    assert.equal(await handle.done, '{"ok":true}');
    assert.ok(activity.some(({ subagentId, event }) => subagentId === "step-attempt" && event.type === "message"));
    assert.equal(events.filter((event) => event.type === "turn_started").length, 0);
    await session.prompt("Parent remains usable");
    assert.ok(events.some((event) => event.type === "turn_ended"));
  } finally { await session.dispose(); }
});
