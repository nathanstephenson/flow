import assert from "node:assert/strict";
import { it } from "node:test";
import { z } from "zod";
import { piSessionTools } from "../../src/backend/pi/session-tools.ts";
import { sessionListInput, sessionListDescription, type SessionTools } from "../../src/backend/session-tools.ts";
import { piFixture, until } from "./pi-fixture.ts";

const id = "930a74e4-c171-4e72-ad93-d6fb58dfe6ed";
const names = ["session_list", "session_inspect", "session_create", "session_send"];
const builder = { instructions: "Build only", read: async () => "", list: async () => "", write: async () => "" };
function capabilities() {
  const calls: { method: string; input: unknown; signal?: AbortSignal }[] = [];
  const call = (method: string) => async (input: unknown, signal?: AbortSignal) => {
    calls.push({ method, input, ...(signal ? { signal } : {}) });
    return { method, ok: true };
  };
  const sessionTools: SessionTools = { list: call("list"), inspect: call("inspect"), create: call("create"), send: call("send") };
  return { sessionTools, calls };
}

it("Pi session tools reuse shared schemas/descriptions and forward mutating cancellation", async () => {
  const { sessionTools, calls } = capabilities();
  assert.deepEqual(piSessionTools(), []);
  const tools = piSessionTools(sessionTools);
  assert.deepEqual(tools.map(tool => tool.name), names);
  const schema = Object.fromEntries(Object.entries(tools[0]!.parameters).filter(([key]) => key !== "~standard"));
  assert.deepEqual(schema, z.toJSONSchema(sessionListInput, { io: "input" }));
  assert.equal(tools[0]!.description, sessionListDescription);
  const signal = new AbortController().signal;
  const create = tools.find(tool => tool.name === "session_create")!;
  const result = await create.execute("create", { text: "Start work" } as never, signal);
  assert.deepEqual(JSON.parse(result.content[0]!.text), { method: "create", ok: true });
  assert.equal(calls[0]!.signal, signal);
});

it("Pi parent exposes session tools, pre-approves only reads, and gates create/send on normal permissions", { timeout: 15000 }, async t => {
  const { sessionTools, calls } = capabilities();
  const f = await piFixture(t, request => request.messages.at(-1)?.role === "user" ? { tools: [
    { id: "list", name: "session_list", arguments: {} },
    { id: "inspect", name: "session_inspect", arguments: { sessionId: id } },
    { id: "create", name: "session_create", arguments: { text: "Start work" } },
    { id: "send", name: "session_send", arguments: { sessionId: id, text: "More work" } },
  ] } : { text: "done" });
  const session = await f.create({ sessionTools, permissionMode: "ask" });
  const prompt = session.prompt("Manage Agent Sessions");
  await until(() => f.events.some(event => event.type === "permission" && event.callId === "create" && event.state === "asked"));
  assert.deepEqual(f.requests[0]!.tools?.map(tool => tool.function.name).filter(name => name.startsWith("session_")).sort(), [...names].sort());
  assert.equal(calls.some(call => call.method === "create" || call.method === "send"), false);
  assert.equal(await session.answerPermission!("create", "allow"), true);
  await until(() => f.events.some(event => event.type === "permission" && event.callId === "send" && event.state === "asked"));
  assert.equal(await session.answerPermission!("send", "deny"), true);
  await prompt;
  assert.deepEqual(calls.map(call => call.method).sort(), ["create", "inspect", "list"]);
  assert.ok(calls.find(call => call.method === "create")!.signal instanceof AbortSignal);
  assert.deepEqual(f.events.filter(event => event.type === "permission" && event.state === "asked").map(event => event.tool), ["session_create", "session_send"]);
});

for (const mode of ["always", "standing"] as const) it(`Pi session writes honour ${mode} authorisation`, { timeout: 15000 }, async t => {
  const { sessionTools, calls } = capabilities();
  const f = await piFixture(t, request => request.messages.at(-1)?.role === "user" ? { tools: [
    { id: "send", name: "session_send", arguments: { sessionId: id, text: "More work" } },
  ] } : { text: "done" });
  const session = await f.create({ sessionTools, permissionMode: mode === "always" ? "always" : "ask",
    standingAuthorisations: mode === "standing" ? ["session_send"] : [] });
  await session.prompt("Send work");
  assert.deepEqual(calls.map(call => call.method), ["send"]);
  assert.equal(f.events.some(event => event.type === "permission"), false);
});

for (const variant of ["absent", "none", "builder"] as const) it(`Pi excludes session tools for ${variant}`, { timeout: 15000 }, async t => {
  const { sessionTools, calls } = capabilities();
  const f = await piFixture(t, () => ({ text: "done" }));
  const session = await f.create(variant === "absent" ? {} : { sessionTools,
    ...(variant === "none" ? { tools: "none" as const } : { workflowBuilder: builder }) });
  await session.prompt("No session tools");
  assert.equal(f.requests[0]!.tools?.some(tool => tool.function.name.startsWith("session_")) ?? false, false);
  assert.deepEqual(calls, []);
});

it("Pi excludes parent session capabilities from ordinary Subagents and Workflow Steps", { timeout: 15000 }, async t => {
  const { sessionTools, calls } = capabilities();
  const f = await piFixture(t, request => request.model === "parent" && request.messages.at(-1)?.role === "user" ? { tools: [
    { id: "child", name: "subagent", arguments: { prompt: "Delegated work", description: "Do work", model: "flow-test/child", run_in_background: false } },
  ] } : { text: "{}" });
  const session = await f.create({ sessionTools });
  await session.prompt("Delegate work");
  const step = session.startWorkflowSubagent!({ id: "step", name: "Step", instructions: "Work", input: {},
    modelId: "flow-test/child", effort: "high", permissionMode: "auto-accept", emit: () => {} });
  await step.done;
  const childRequests = f.requests.filter(request => request.model === "child");
  assert.ok(childRequests.length >= 2);
  for (const request of childRequests) assert.equal(request.tools?.some(tool => tool.function.name.startsWith("session_")) ?? false, false);
  assert.deepEqual(calls, []);
});
