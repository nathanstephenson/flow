import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { WorkerBackend } from "../src/backend/worker/index.ts";
import { SandboxMcpSession } from "../src/backend/worker/sandbox-mcp.ts";
import { createSandbox, sandboxMounts } from "../src/isolation/sandbox.ts";
import type { McpConnection } from "../src/protocol/mcp.ts";
import { createCodeExecutors } from "../src/workflows/executors.ts";
import type { ExecutorContext } from "../src/workflows/scheduler.ts";
import { fakeProvider } from "./backend/sandbox-fixture.ts";

const backendModule = new URL("./backend/worker-fixture.ts", import.meta.url).href;

test("sandbox Workflow code runs through the session VM, which stays until the step ends", async (t) => {
  const f = fakeProvider(t);
  const runtimePath = join(f.state, "runtime.cjs");
  execFileSync(process.execPath, ["scripts/build-workflow-runtime.mjs", runtimePath]);
  const sandbox = await createSandbox(f.support.provider, { name: "flow-test", workspace: f.scope,
    mounts: sandboxMounts([f.scope, f.state], []), env: {} }, join(f.state, "sandbox.json"));
  const sessions: string[] = [];
  const executors = await createCodeExecutors({ runtimePath, nodePath: "/not/used", isolationMode: "sandbox", stateRoot: f.stateRoot,
    sandbox: async (sessionId) => { sessions.push(sessionId); return sandbox; } });
  const context: ExecutorContext = { sessionId: "s1", executionId: "e", scope: f.scope, input: null, permission: "auto-accept",
    step: { id: "a", name: "a", kind: "shell", command: "sleep 1; printf ran > ran" }, signal: new AbortController().signal };
  const running = executors.shell.execute(context);
  await new Promise((done) => setTimeout(done, 300));
  const closing = sandbox.close();
  await running;
  await closing;
  assert.equal(existsSync(join(f.scope, "ran")), true);
  assert.deepEqual(sessions, ["s1"]);
  const calls = f.calls();
  assert.ok(calls.some((call) => call.startsWith(`exec flow-test ${f.scope}`)));
  assert.equal(calls.at(-1), "remove flow-test");
  assert.throws(() => sandbox.hold(), /stopping/);
  rmSync(runtimePath);
});

test("a sandbox direct MCP Workflow Step calls its tool through the session's worker", async (t) => {
  const f = fakeProvider(t);
  const connection: McpConnection = { id: "fixture", name: "Fixture", transport: "stdio", enabledByDefault: true,
    command: process.execPath, args: ["--experimental-strip-types", resolve("test/fixtures/mcp-server.ts")] };
  const mcp = new SandboxMcpSession([connection], f.scope);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, mcp, emit: () => {} });
  t.after(() => session.dispose());
  await mcp.open();
  const direct = await mcp.directView("fixture");
  await direct.open();
  assert.equal(direct.status()[0]?.state, "connected");
  const echo = direct.tools().find((tool) => tool.name.endsWith("__echo"));
  assert.ok(echo);
  assert.deepEqual((await echo.call({ text: "from step" })).content, [{ type: "text", text: "from step" }]);
  await assert.rejects(mcp.directView("other"), /not selected/);
});
