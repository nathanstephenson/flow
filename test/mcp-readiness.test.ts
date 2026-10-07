import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { SessionHost } from "../src/daemon/host.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { McpSession } from "../src/backend/mcp.ts";
import type { BackendSession } from "../src/backend/types.ts";
import { prepareFilesystemIsolation } from "../src/isolation/filesystem.ts";

const connection = { id: "fixture", name: "Fixture", enabledByDefault: true, transport: "stdio" as const,
  command: process.execPath, args: ["--experimental-strip-types", resolve("test/fixtures/mcp-server.ts")] };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for backend prompt");
    await new Promise(resolve => setImmediate(resolve));
  }
}

test("immediate MCP disposal does not start clients after shutdown", { timeout: 1000 }, async () => {
  const mcp = new McpSession([{ ...connection, args: ["-e", "setInterval(() => {}, 1000)"] }], process.cwd());
  const opening = mcp.open();
  await mcp.dispose();
  await opening;
  assert.deepEqual(mcp.tools(), []);
});

test("first prompt waits for discovery and registration; Retry cannot race a new prompt", { timeout: 5000 }, async (t) => {
  try {
    (await prepareFilesystemIsolation({ scope: process.cwd(), command: process.execPath, args: [], credentials: "none" })).cleanup();
  } catch (error) { t.skip(`Filesystem isolation unavailable: ${(error as Error).message}`); return; }
  const host = new SessionHost({ mcpConnections: () => [connection] });
  const fake = new FakeBackend();
  let entered = deferred();
  let release = deferred();
  let prompts = 0;
  host.registerBackend({ name: "fake", create: async (options) => {
    const session = await fake.create(options);
    session.prompt = async () => { prompts++; };
    return Object.assign(session, { refreshMcp: async () => {
      assert.equal(options.mcp?.tools().length, 2);
      entered.resolve();
      await release.promise;
    } });
  } });
  try {
    const id = await host.create({ scope: process.cwd() });
    const first = host.send(id, "first", "now");
    await entered.promise;
    assert.equal(prompts, 0);
    await assert.rejects(host.retryMcp(id, "fixture"), /Idle/);
    release.resolve();
    await first;
    await until(() => prompts === 1);
    assert.equal(prompts, 1);
  } finally { release.resolve(); await host.shutdown(); }

  const retryHost = new SessionHost({ mcpConnections: () => [connection] });
  let session!: BackendSession;
  let registrations = 0;
  entered = deferred(); release = deferred();
  retryHost.registerBackend({ name: "fake", create: async (options) => {
    session = await fake.create(options);
    session.prompt = async () => { prompts++; };
    session.refreshMcp = async () => { if (++registrations === 2) { entered.resolve(); await release.promise; } };
    return session;
  } });
  try {
    const id = await retryHost.create({ scope: process.cwd() });
    const retry = retryHost.retryMcp(id, "fixture");
    const prompt = retryHost.send(id, "during Retry", "now");
    await entered.promise;
    assert.equal(prompts, 1);
    release.resolve();
    await Promise.all([retry, prompt]);
    await until(() => prompts === 2);
    assert.equal(prompts, 2);
  } finally { release.resolve(); await retryHost.shutdown(); }
});

test("Workflow Steps wait for registration and block Retry until stopped", { timeout: 5000 }, async () => {
  const host = new SessionHost({ mcpConnections: () => [connection] });
  const fake = new FakeBackend();
  const entered = deferred(); const release = deferred(); const work = deferred<string>();
  let started = false;
  host.registerBackend({ name: "fake", create: async (options) => {
    const session: BackendSession = await fake.create(options);
    session.refreshMcp = async () => { entered.resolve(); await release.promise; };
    session.startWorkflowSubagent = () => {
      started = true;
      return { done: work.promise, answerEnquiry: async () => false, answerPermission: async () => false,
        cancel: async () => { work.resolve("stopped"); } };
    };
    return session;
  } });
  try {
    const id = await host.create({ scope: process.cwd() });
    const { session } = await host.openWorkflowSession(id);
    const handle = session!.startWorkflowSubagent!({ id: "step", name: "Step", instructions: "", input: null,
      modelId: "fake", effort: "low", permissionMode: "ask", emit: () => {} });
    await entered.promise;
    assert.equal(started, false);
    await assert.rejects(host.retryMcp(id, "fixture"), /Idle/);
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    await assert.rejects(host.retryMcp(id, "fixture"), /Idle/);
    await handle.cancel();
    await handle.done;
    await host.retryMcp(id, "fixture");
  } finally { release.resolve(); work.resolve("stopped"); await host.shutdown(); }
});

test("failed bounded discovery does not prevent the first prompt", { timeout: 15_000 }, async () => {
  // Exercise discovery even without Bubblewrap: this inert fixture runs no tools, and an
  // immediate isolation failure would hide regressions in waiting for the discovery deadline.
  const host = new SessionHost({ filesystemIsolationEnabled: () => false,
    mcpConnections: () => [{ ...connection, args: ["-e", "setInterval(() => {}, 1000)"] }] });
  const fake = new FakeBackend();
  const prompted = deferred<string | undefined>();
  host.registerBackend({ name: "fake", create: async (options) => {
    const session = await fake.create(options);
    session.prompt = async () => { prompted.resolve(options.mcp?.status()[0]?.state); };
    return session;
  } });
  try {
    const id = await host.create({ scope: process.cwd() });
    await host.send(id, "first", "now");
    // Discovery intentionally waits up to 10 seconds for this unresponsive server. Await the
    // actual prompt callback under the test's 15-second deadline, not the 2-second polling helper.
    assert.equal(await prompted.promise, "failed");
  } finally { await host.shutdown(); }
});

for (const operation of ["prompt", "compact"] as const) {
  test(`Stop cancels ${operation} during MCP registration and permits the next message`, { timeout: 5000 }, async () => {
    const host = new SessionHost({ mcpConnections: () => [connection] });
    const fake = new FakeBackend({ compaction: true });
    const entered = deferred(); const release = deferred();
    host.registerBackend({ name: "fake", create: async (options) => {
      const session = await fake.create(options);
      return Object.assign(session, { refreshMcp: async () => { entered.resolve(); await release.promise; } });
    } });
    try {
      const id = await host.create({ scope: process.cwd() });
      const pending = operation === "prompt" ? host.send(id, "stopped", "now") : host.compact(id);
      await entered.promise;
      await host.abort(id);
      await pending;
      assert.equal(host.list()[0]?.status, "idle");
      const next = host.send(id, "next", "after_turn");
      release.resolve();
      await next;
      await until(() => fake.sessions[0]!.prompts.length === 1);
      assert.deepEqual(fake.sessions[0]!.prompts, ["next"]);
      assert.deepEqual(fake.sessions[0]!.compactions, []);
    } finally { release.resolve(); await host.shutdown(); }
  });
}

for (const readiness of ["no connections", "registered", "retried"] as const) {
  test(`settled MCP readiness starts backend work synchronously: ${readiness}`, { timeout: 5000 }, async () => {
    const host = new SessionHost({ mcpConnections: () => readiness === "no connections" ? [] : [connection] });
    const fake = new FakeBackend();
    let session!: BackendSession;
    const calls: string[] = [];
    host.registerBackend({ name: "fake", create: async (options) => {
      session = await fake.create(options);
      session.prompt = async () => { calls.push("prompt"); };
      session.compact = async () => { calls.push("compact"); };
      session.refreshMcp = async () => {};
      session.startWorkflowSubagent = () => {
        calls.push("workflow");
        return { done: Promise.resolve("done"), answerEnquiry: async () => false,
          answerPermission: async () => false, cancel: async () => {} };
      };
      return session;
    } });
    try {
      const id = await host.create({ scope: process.cwd() });
      if (readiness !== "no connections") await session.prompt("initial");
      if (readiness === "retried") await host.retryMcp(id, "fixture");
      calls.length = 0;
      const prompt = session.prompt("next");
      assert.deepEqual(calls, ["prompt"]);
      await prompt;
      const compact = session.compact!();
      assert.deepEqual(calls, ["prompt", "compact"]);
      await compact;
      const handle = session.startWorkflowSubagent!({ id: "step", name: "Step", instructions: "", input: null,
        modelId: "fake", effort: "low", permissionMode: "ask", emit: () => {} });
      assert.deepEqual(calls, ["prompt", "compact", "workflow"]);
      await handle.done;
    } finally { await host.shutdown(); }
  });
}

test("queued Retries keep prompts gated until the final registration", { timeout: 5000 }, async () => {
  const host = new SessionHost({ mcpConnections: () => [connection] });
  const fake = new FakeBackend();
  const entered = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  let registrations = 0;
  let prompts = 0;
  host.registerBackend({ name: "fake", create: async (options) => {
    const session = await fake.create(options);
    session.prompt = async () => { prompts++; };
    session.refreshMcp = async () => {
      const retry = registrations++ - 1;
      if (retry < 0) return;
      entered[retry]!.resolve();
      await release[retry]!.promise;
    };
    return session;
  } });
  try {
    const id = await host.create({ scope: process.cwd() });
    const first = host.retryMcp(id, "fixture");
    const second = host.retryMcp(id, "fixture");
    await entered[0]!.promise;
    assert.equal(registrations, 2);
    release[0]!.resolve();
    await first;
    await entered[1]!.promise;
    const prompt = host.send(id, "after both Retries", "now");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompts, 0);
    release[1]!.resolve();
    await Promise.all([second, prompt]);
    await until(() => prompts === 1);
    assert.equal(prompts, 1);
  } finally { release.forEach((gate) => gate.resolve()); await host.shutdown(); }
});

test("Workflow cancellation settles before MCP registration", { timeout: 5000 }, async () => {
  const host = new SessionHost({ mcpConnections: () => [connection] });
  const fake = new FakeBackend();
  const entered = deferred(); const release = deferred();
  let started = false;
  host.registerBackend({ name: "fake", create: async (options) => {
    const session: BackendSession = await fake.create(options);
    session.refreshMcp = async () => { entered.resolve(); await release.promise; };
    session.startWorkflowSubagent = () => { started = true; throw new Error("must not start"); };
    return session;
  } });
  try {
    const id = await host.create({ scope: process.cwd() });
    const { session } = await host.openWorkflowSession(id);
    const handle = session!.startWorkflowSubagent!({ id: "step", name: "Step", instructions: "", input: null,
      modelId: "fake", effort: "low", permissionMode: "ask", emit: () => {} });
    const stopped = assert.rejects(handle.done, /stopped/);
    await entered.promise;
    await handle.cancel();
    await stopped;
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, false);
  } finally { release.resolve(); await host.shutdown(); }
});
