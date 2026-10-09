import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { WorkerRpc, type WireMessage } from "../../src/backend/worker/rpc.ts";
import type { BackendCreateOptions, BackendSession, WorkflowSubagentOptions } from "../../src/backend/types.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import type { McpSession, McpTool } from "../../src/backend/mcp.ts";
import { until, piFixture } from "./pi-fixture.ts";
import { isolationIntegration, privateWorkerState } from "../isolation-fixture.ts";

const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;
const workflowOptions: Omit<WorkflowSubagentOptions, "emit"> = { id: "workflow", name: "fixture", instructions: "wait", input: null, modelId: "fixture", effort: "off", permissionMode: "ask" };
async function fixture(t: TestContext, overrides: Partial<BackendCreateOptions> = {}, timeout = 2000) {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-"));
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, shutdownTimeoutMs: timeout });
  const session = await backend.create({ scope, emit: (event) => events.push(event), ...overrides });
  t.after(async () => { await session.dispose(); await rm(scope, { recursive: true, force: true }); });
  return { session, scope, events };
}

test("worker provides synchronous snapshots and updates them before emitting model events", isolationIntegration, async (t) => {
  let session: BackendSession | undefined;
  const observations: Array<[string, string | undefined]> = [];
  const f = await fixture(t, { emit: (event) => {
    if (event.type === "model_changed") observations.push([session!.capabilities.providers[0]!, session!.resumeToken()]);
  } });
  session = f.session;
  assert.equal(session.resumeToken(), "initial-token");
  assert.deepEqual(session.capabilities.providers, ["fixture"]);
  await session.setModel("new-model");
  assert.deepEqual(observations, [["new-model", "new-model"]]);
  assert.deepEqual(await session.skills!(), [{ name: "fixture", description: "fixture skill" }]);
  await session.setEffort("high");
  await session.compact!();
});

test("worker preserves startup permission policy and confirms live changes through IPC", isolationIntegration, async t => {
  const { session, events } = await fixture(t, { permissionMode: "ask" });
  const readMode = async () => {
    await session.prompt("permission-mode");
    const event = events.findLast(event => event.type === "message" && event.id === "permission-mode");
    assert.ok(event?.type === "message");
    return event.text;
  };
  assert.equal(await readMode(), "ask");
  assert.equal(typeof session.setPermissionMode, "function");
  await session.setPermissionMode!("always");
  assert.equal(await readMode(), "always");
  await assert.rejects(session.setPermissionMode!("auto"), /does not support Auto/);
  assert.equal(await readMode(), "always", "a rejected change cannot replace the confirmed policy");
  await session.setPermissionMode!("ask");
  assert.equal(await readMode(), "ask");
});

test("held prompt does not block enquiry answers, permission answers or abort", isolationIntegration, async (t) => {
  const { session, events } = await fixture(t);
  for (const answer of [() => session.answerEnquiry!("open", [["yes"]]), () => session.answerPermission!("open", "allow"), () => session.abort()]) {
    const count = events.length;
    const prompt = session.prompt("hold");
    await until(() => events.length > count);
    await answer();
    await prompt;
    assert.equal(events.at(-1)?.type, "turn_ended");
  }
  assert.equal(await session.answerEnquiry!("stale", []), false);
  assert.equal(await session.answerPermission!("stale", "always"), false);
});

test("MCP stays host-owned and metadata refresh reaches the worker", isolationIntegration, async (t) => {
  let calls = 0;
  const tools: McpTool[] = [{ name: "mcp__fixture__tool", connectionId: "fixture", definition: { name: "tool", inputSchema: { type: "object" } }, serverIdentity: "identity", call: async (input, signal, timeout) => {
    calls++;
    assert.deepEqual(input, { fixture: true });
    assert.ok(signal instanceof AbortSignal);
    assert.equal(timeout, 1234);
    return { content: [{ type: "text", text: "host result" }] };
  } }];
  const { session, events } = await fixture(t, { mcp: { tools: () => tools } as McpSession });
  await session.prompt("mcp");
  assert.equal(calls, 1);
  assert.ok(events.some((event) => event.type === "message" && event.text.includes("host result")));
  tools.push({ ...tools[0]!, name: "mcp__fixture__new" });
  await session.refreshMcp!();
  assert.ok(events.some((event) => event.type === "message" && event.text.includes("mcp__fixture__new")));
});

test("Claude MCP bridges retain selected connections across delayed discovery and refresh", { timeout: 20_000 }, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-mcp-"));
  const events: BackendEvent[] = [];
  const tools: McpTool[] = [];
  let calls = 0;
  const mcp = { connections: [{ id: "fixture" }, { id: "offline" }], tools: () => tools } as unknown as McpSession;
  const backend = new WorkerBackend({ backendModule, isolationEnabled: () => false });
  const session = await backend.create({ scope, mcp, emit: (event) => events.push(event) });
  t.after(async () => { await session.dispose(); await rm(scope, { recursive: true, force: true }); });
  const listing = async () => {
    await session.prompt("claude-mcp");
    const event = events.findLast((event) => event.type === "message" && event.id === "claude-mcp");
    assert.ok(event?.type === "message");
    return JSON.parse(event.text);
  };
  assert.deepEqual(await listing(), { fixture: [], offline: [] });
  tools.push({ name: "mcp__fixture__tool", connectionId: "fixture",
    definition: { name: "tool", inputSchema: { type: "object" } }, serverIdentity: "identity",
    call: async (input) => {
      assert.deepEqual(input, { fixture: true });
      calls++;
      return { content: [{ type: "text", text: "host result" }] };
    },
  });
  await session.refreshMcp!();
  assert.deepEqual(await listing(), { fixture: ["tool"], offline: [] });
  tools[0] = { ...tools[0]!, name: "mcp__fixture__new", definition: { ...tools[0]!.definition, name: "new" } };
  await session.refreshMcp!();
  assert.deepEqual(await listing(), { fixture: ["new"], offline: [] });
  assert.equal(calls, 2);
});

test("WorkflowParent callbacks remain host-owned and reverse cancellation aborts their signal", isolationIntegration, async (t) => {
  let inspections = 0;
  let cancelled = false;
  const { session } = await fixture(t, { workflow: {
    inspect: async () => { inspections++; return { host: true }; },
    recover: async () => null,
    relayPermission: async () => null,
    relayEnquiry: async (_input, signal) => new Promise((resolve) => {
      signal!.addEventListener("abort", () => { cancelled = true; resolve(null); }, { once: true });
    }),
  } });
  await session.prompt("workflow");
  assert.equal(inspections, 1);
  await session.prompt("cancel-reverse");
  await until(() => cancelled);
});

test("workflow handles deliver early events/done, answers, failures and cancellation", isolationIntegration, async (t) => {
  const { session } = await fixture(t);
  const activity: unknown[] = [];
  const completed = session.startWorkflowSubagent!({ ...workflowOptions, instructions: "finish", emit: (event) => activity.push(event) });
  assert.equal(await completed.done, "finished");
  assert.equal(activity.length, 1);
  const enquiry = session.startWorkflowSubagent!({ ...workflowOptions, emit: () => {} });
  assert.equal(await enquiry.answerEnquiry("stale", []), false);
  assert.equal(await enquiry.answerEnquiry("ask", [["yes"]]), true);
  assert.equal(await enquiry.done, "answered");
  const permission = session.startWorkflowSubagent!({ ...workflowOptions, emit: () => {} });
  assert.equal(await permission.answerPermission("permission", "allow"), true);
  assert.equal(await permission.done, "allowed");
  const cancelled = session.startWorkflowSubagent!({ ...workflowOptions, emit: () => {} });
  const rejected = assert.rejects(cancelled.done, /workflow cancelled/);
  await cancelled.cancel();
  await rejected;
});

test("worker crash rejects pending prompt and workflow done, emits one host error and never replays", isolationIntegration, async (t) => {
  const { session, events } = await fixture(t);
  const handle = session.startWorkflowSubagent!({ ...workflowOptions, emit: () => {} });
  const done = assert.rejects(handle.done, /worker/i);
  await assert.rejects(session.prompt("crash"), /worker/i);
  await done;
  await assert.rejects(session.setEffort("high"), /worker/i);
  assert.equal(events.filter((event) => event.type === "notice" && event.level === "error").length, 1);
});

test("worker loss aborts in-flight host-owned MCP calls", isolationIntegration, async (t) => {
  let signal: AbortSignal | undefined;
  const tool: McpTool = { name: "mcp__fixture__held", connectionId: "fixture", serverIdentity: "identity", definition: { name: "held", inputSchema: { type: "object" } },
    call: async (_input, incoming) => { signal = incoming; return new Promise(() => {}); },
  };
  const { session } = await fixture(t, { mcp: { tools: () => [tool] } as McpSession });
  const held = assert.rejects(session.prompt("mcp-hold"), /worker/i);
  await until(() => signal !== undefined);
  await assert.rejects(session.prompt("crash"), /worker/i);
  await held;
  assert.equal(signal?.aborted, true);
});

test("losing the host terminates the worker PID namespace and its descendants", isolationIntegration, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-orphan-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const parent = join(scope, "parent.mjs");
  const backendUrl = new URL("../../src/backend/worker/index.ts", import.meta.url).href;
  await writeFile(parent, `import {WorkerBackend} from ${JSON.stringify(backendUrl)};
import {readFileSync,readdirSync,readlinkSync} from 'node:fs';
const hostPid = ${hostPid.toString()};
let descriptor;
const session = await new WorkerBackend({backendModule:${JSON.stringify(backendModule)}}).create({scope:${JSON.stringify(scope)},emit(event){if(event.type==='message' && event.id==='process') descriptor=event.text;}});
await session.prompt('descendant');
process.stdout.write(String(hostPid(descriptor))); process.exit(0);`);
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", parent]);
  await until(() => { try { return requireState(Number(stdout)) === "Z"; } catch { return true; } });
});

test("dispose awaits owned work, is idempotent and does not report normal shutdown as an error", isolationIntegration, async (t) => {
  const { session, events, scope } = await fixture(t);
  const handle = session.startWorkflowSubagent!({ ...workflowOptions, emit: () => {} });
  const done = assert.rejects(handle.done, /cancelled|stopped/);
  await session.prompt("descendant");
  const processEvent = events.find((event) => event.type === "message" && event.id === "process");
  assert.ok(processEvent?.type === "message");
  const pid = hostPid(processEvent.text);
  assert.ok(pid > 0);
  const first = session.dispose();
  assert.equal(first, session.dispose());
  await first;
  await done;
  assert.equal(await readFile(join(scope, "disposed"), "utf8"), "yes");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(events.filter((event) => event.type === "notice" && event.level === "error").length, 0);
});

test("forced disposal kills descendants when worker cleanup never returns", isolationIntegration, async (t) => {
  const { session, events } = await fixture(t, { modelId: "dispose-hang" }, 100);
  await session.prompt("descendant");
  const event = events.find((event) => event.type === "message" && event.id === "process");
  assert.ok(event?.type === "message");
  const pid = hostPid(event.text);
  const start = Date.now();
  await session.dispose();
  assert.ok(Date.now() - start < 2000);
  // On Linux an orphan can remain a zombie briefly; it cannot execute any further work.
  if (process.platform === "linux") {
    await until(() => { try { return requireState(pid) === "Z"; } catch { return true; } });
  } else assert.throws(() => process.kill(pid, 0));
});

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
function hostPid(text: string): number {
  const descriptor = JSON.parse(text) as { pid: number; namespace: string };
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(`/proc/${entry}/ns/pid`) !== descriptor.namespace) continue;
      const pids = readFileSync(`/proc/${entry}/status`, "utf8").match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/);
      if (Number(pids?.at(-1)) === descriptor.pid) return Number(entry);
    } catch { /* A sibling process can exit during the scan. */ }
  }
  throw new Error("Descendant was not found in its private PID namespace");
}
function requireState(pid: number) { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0]; }

test("initialization failures and deadlines reject without leaking workers", isolationIntegration, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-create-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const backend = new WorkerBackend({ backendModule, startupTimeoutMs: 100, shutdownTimeoutMs: 100 });
  // Give the explicit failing backend enough startup time for a slow CI machine.
  await assert.rejects(new WorkerBackend({ backendModule }).create({ scope, modelId: "create-error", emit: () => {} }), /fixture create failed/);
  await assert.rejects(backend.create({ scope, modelId: "create-hang", emit: () => {} }), /cancelled/);
});

test("host rejects arbitrary reverse method names rather than invoking prototype functions", isolationIntegration, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-hostile-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const entry = join(scope, "hostile.mjs");
  await writeFile(entry, `process.on('message', m => {
    if (m.kind === 'call' && m.method === 'create') {
      process.send({kind:'call',id:99,method:'constructor',args:[]});
      process.send({kind:'reply',id:m.id,value:{capabilities:{providers:[],models:[],compaction:false,fork:false,subagents:false,enquiries:false,permissions:false},methods:[]}});
    } else if(m.kind === 'reply' && m.id === 99) {
      process.send({kind:'notification',name:'event',value:{event:{type:'notice',level:'info',text:m.error}}});
    } else if(m.kind === 'call' && m.method === 'dispose') {
      process.send({kind:'reply',id:m.id}); process.disconnect();
    }
  });`);
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({ entry }).create({ scope, emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  await until(() => events.length > 0);
  assert.ok(events.some((event) => event.type === "notice" && /Unknown host method: constructor/.test(event.text)));
  assert.equal(session.skills, undefined);
  assert.equal(session.compact, undefined);
});

test("RPC close rejects calls and aborts in-flight host callbacks", async () => {
  const outgoing: WireMessage[] = [];
  let signal: AbortSignal | undefined;
  const rpc = new WorkerRpc((message) => outgoing.push(message), async (_method, _args, incoming) => { signal = incoming; return new Promise(() => {}); }, () => {});
  const pending = rpc.call("hold");
  rpc.receive({ kind: "call", id: 5, method: "hold", args: [] });
  await Promise.resolve();
  rpc.close(new Error("gone"));
  await assert.rejects(pending, /gone/);
  assert.equal(signal?.aborted, true);
  await assert.rejects(rpc.call("new"), /gone/);
});

test("installed Pi SDK operates across the worker boundary with isolated state", isolationIntegration, async (t) => {
  const f = await piFixture(t, () => ({ text: "worker SDK response" }));
  const { scope, stateDir } = privateWorkerState(t);
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1" } });
  const session = await backend.create({ scope, stateDir, modelId: "flow-test/parent", emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  assert.equal(session.resumeToken(), "/tmp/flow-isolation/state");
  await session.prompt("hello");
  assert.ok(events.some((event) => event.type === "message" && event.text === "worker SDK response" && event.final));
  assert.equal(events.at(-1)?.type, "turn_ended");
  assert.equal(f.requests.length, 1);
  await session.dispose();
});
