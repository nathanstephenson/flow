import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import { ClaudeBackend, AutoPermissionUnavailable } from "../../src/backend/claude/index.ts";
import { runNativeAutoScenario, runNativeAutoSubagentIncompatibilityScenario } from "./claude-native-auto.fixture.ts";

it("attributes an ordinary Claude Subagent's Auto escalation and keeps it answerable across live mode changes", async () => {
  const messages = new AsyncQueue<SDKMessage>();
  const events: BackendEvent[] = [];
  const modes: string[] = [];
  let canUseTool: NonNullable<Options["canUseTool"]> | undefined;
  const backend = new ClaudeBackend({ query: ((args: Parameters<typeof query>[0]) => {
    canUseTool = args.options?.canUseTool;
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => [{ value: "sonnet", supportedEffortLevels: ["high"] }],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      setPermissionMode: async (mode: string) => { modes.push(mode); },
      close: () => messages.close(),
    } as unknown as Query;
  }) as typeof query, allowedTools: [] });
  const session = await backend.create({ scope: "/tmp", emit: (event) => events.push(event), permissionMode: "auto" });
  assert.deepEqual(modes, ["auto"]);
  assert.ok(canUseTool);
  const permissionCallback = canUseTool;

  // The native SDK's agentID is the task id, while transcript attribution uses the Agent tool id.
  // Feed the real ordering so this regression catches either id being mistaken for the other.
  messages.push({
    type: "assistant", parent_tool_use_id: null, session_id: "session-1", uuid: "assistant-1",
    message: { id: "message-1", type: "message", role: "assistant", model: "sonnet", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{
      type: "tool_use", id: "agent-call-1", name: "Agent",
      input: { description: "permission probe", prompt: "run git push", subagent_type: "general-purpose" },
    }] },
  } as unknown as SDKMessage);
  messages.push({
    type: "system", subtype: "task_started", session_id: "session-1", uuid: "task-started-1",
    task_id: "sdk-task-1", tool_use_id: "agent-call-1", description: "permission probe",
    subagent_type: "general-purpose", is_backgrounded: false,
  } as unknown as SDKMessage);
  await new Promise((resolve) => setImmediate(resolve));

  const escalated = permissionCallback("Bash", { command: "git push" }, {
    toolUseID: "sub-tool-1", agentID: "sdk-task-1", requestId: "request-1",
    signal: AbortSignal.timeout(1000), suggestions: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.find((event) => event.type === "permission" && event.state === "asked"), {
    type: "permission", callId: "sub-tool-1", tool: "Bash",
    producer: { subagentId: "agent-call-1" }, state: "asked",
  });
  assert.equal(await session.answerPermission!("sub-tool-1", "allow"), true);
  assert.deepEqual(await escalated, { behavior: "allow", updatedInput: { command: "git push" } });
  assert.deepEqual(events.find((event) => event.type === "permission" && event.state === "decided"), {
    type: "permission", callId: "sub-tool-1", tool: "Bash",
    producer: { subagentId: "agent-call-1" }, state: "decided", decision: "allow",
  });

  const refused = permissionCallback("Bash", { command: "git push --force" }, {
    toolUseID: "sub-tool-2", agentID: "sdk-task-1", requestId: "request-2",
    signal: AbortSignal.timeout(1000), suggestions: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await session.answerPermission!("sub-tool-2", "deny"), true);
  assert.deepEqual(await refused, { behavior: "deny", message: "Bash is not enabled for this session. Continue without it." });
  assert.deepEqual(events.find((event) => event.type === "permission" && event.state === "decided" && event.callId === "sub-tool-2"), {
    type: "permission", callId: "sub-tool-2", tool: "Bash",
    producer: { subagentId: "agent-call-1" }, state: "decided", decision: "deny",
  });

  await session.setPermissionMode?.("always");
  assert.deepEqual(modes, ["auto", "default"]);
  assert.deepEqual(await permissionCallback("Bash", { command: "git push" }, {
    toolUseID: "sub-tool-3", agentID: "sdk-task-1", requestId: "request-3",
    signal: AbortSignal.timeout(1000), suggestions: [],
  }), { behavior: "allow", updatedInput: { command: "git push" } });
  assert.equal(events.filter((event) => event.type === "permission" && event.state === "asked").length, 2);
  await session.dispose();
});

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Real SDK message ordering, without needing a model to ask for a particular dangerous tool. */
async function permissionFixture(t: TestContext) {
  const messages = new AsyncQueue<SDKMessage | Error>();
  const events: BackendEvent[] = [];
  let callback: NonNullable<Options["canUseTool"]> | undefined;
  let interrupts = 0;
  const backend = new ClaudeBackend({ allowedTools: [], query: ((args: Parameters<typeof query>[0]) => {
    callback = args.options?.canUseTool;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of messages) {
          if (message instanceof Error) throw message;
          yield message;
        }
      },
      supportedModels: async () => [{ value: "sonnet", supportedEffortLevels: ["high"] }],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      setPermissionMode: async () => {},
      interrupt: async () => { interrupts++; },
      close: () => messages.close(),
    } as unknown as Query;
  }) as typeof query });
  const session = await backend.create({ scope: "/tmp", emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  assert.ok(callback);
  const canUseTool = callback;
  const push = (message: unknown) => messages.push(message as SDKMessage);
  const spawn = async (id: string, background = true) => {
    push({
      type: "assistant", parent_tool_use_id: null, session_id: "session", uuid: `assistant-${id}`,
      message: { id: `message-${id}`, content: [{
        type: "tool_use", id, name: "Agent", input: { subagent_type: "general-purpose", description: id },
      }] },
    });
    push({ type: "system", subtype: "task_started", task_id: `task-${id}`, tool_use_id: id });
    if (background) push({
      type: "user", parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "launched" }] },
      tool_use_result: { status: "async_launched" },
    });
    await drain();
  };
  const request = (callId: string, producer?: string, controller = new AbortController()) => ({
    controller,
    result: canUseTool("Bash", { command: callId }, {
      toolUseID: callId, ...(producer ? { agentID: `task-${producer}` } : {}),
      signal: controller.signal, suggestions: [], requestId: `request-${callId}`,
    }).then((result) => { assert.ok(result); return result; }),
  });
  const finish = async () => {
    push({ type: "result", subtype: "success" });
    await drain();
  };
  const permissions = (callId: string) => events.filter((event) => event.type === "permission" && event.callId === callId);
  return { session, events, push, spawn, request, finish, permissions, interrupts: () => interrupts,
    fail: () => messages.push(new Error("fixture stream failed")),
  };
}

it("keeps a detached permission through parent completion and subsequent turns, but not the parent's prompt", async (t) => {
  const f = await permissionFixture(t);
  // A callback can arrive before the launch receipt detaches its owner.
  await f.spawn("child", false);
  const child = f.request("child-call", "child");
  const parent = f.request("parent-call");
  f.push({ type: "user", parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "child", content: "launched" }] },
    tool_use_result: { status: "async_launched" },
  });
  await f.finish();
  assert.equal((await parent.result).behavior, "deny");
  assert.equal(f.events.filter((event) => event.type === "turn_ended").length, 1);
  assert.deepEqual(f.permissions("child-call"), [{
    type: "permission", callId: "child-call", tool: "Bash", producer: { subagentId: "child" }, state: "asked",
  }]);
  assert.equal(getEventListeners(child.controller.signal, "abort").length, 1);

  f.push({ type: "assistant", parent_tool_use_id: null, message: { id: "next-turn", content: [] } });
  await f.finish();
  assert.equal(f.events.filter((event) => event.type === "turn_ended").length, 2);
  assert.equal(f.permissions("child-call").length, 1);
  assert.equal(await f.session.answerPermission!("child-call", "allow"), true);
  assert.deepEqual(await child.result, { behavior: "allow", updatedInput: { command: "child-call" } });
  assert.equal(getEventListeners(child.controller.signal, "abort").length, 0);
  assert.equal(await f.session.answerPermission!("child-call", "always"), false);
  child.controller.abort();
  assert.equal(f.permissions("child-call").length, 2);
});

it("isolates refusals by producer and retains a detached refusal across parent turns", async (t) => {
  const f = await permissionFixture(t);
  await f.spawn("a");
  await f.spawn("b");
  const denied = f.request("a-denied", "a");
  assert.equal(await f.session.answerPermission!("a-denied", "deny"), true);
  assert.equal((await denied.result).behavior, "deny");
  const parent = f.request("parent");
  const sibling = f.request("b-allowed", "b");
  assert.equal(await f.session.answerPermission!("parent", "deny"), true);
  assert.equal((await parent.result).behavior, "deny");
  assert.equal(await f.session.answerPermission!("b-allowed", "allow"), true);
  assert.equal((await sibling.result).behavior, "allow");
  await f.finish();

  const retry = f.request("a-retry", "a");
  assert.equal((await retry.result).behavior, "deny");
  assert.deepEqual(f.permissions("a-retry"), [], "the child's refusal survives its spawning turn");
  const nextParent = f.request("parent-next");
  assert.equal(f.permissions("parent-next").length, 1, "the parent's own refusal was cleared");
  assert.equal(await f.session.answerPermission!("parent-next", "allow"), true);
  assert.equal((await nextParent.result).behavior, "allow");
});

for (const [status, state] of [["completed", "complete"], ["killed", "aborted"], ["failed", "error"]] as const) {
  it(`abandons only the terminated child's pending permissions on ${status}, once`, async (t) => {
    const f = await permissionFixture(t);
    await f.spawn("child");
    await f.spawn("sibling");
    const stopped = f.request("stopped", "child");
    const sibling = f.request("sibling-call", "sibling");
    await f.finish();
    f.push({ type: "system", subtype: "task_updated", task_id: "task-child", patch: { status } });
    f.push({ type: "system", subtype: "task_notification", task_id: "task-child", tool_use_id: "child", status });
    await drain();
    assert.equal((await stopped.result).behavior, "deny");
    assert.equal(getEventListeners(stopped.controller.signal, "abort").length, 0);
    assert.deepEqual(f.permissions("stopped"), [
      { type: "permission", callId: "stopped", tool: "Bash", producer: { subagentId: "child" }, state: "asked" },
      { type: "permission", callId: "stopped", tool: "Bash", producer: { subagentId: "child" }, state: "aborted" },
    ]);
    assert.equal(f.events.filter((event) => event.type === "subagent" && event.subagentId === "child" && event.state === state).length, 1);
    assert.equal(await f.session.answerPermission!("stopped", "always"), false);
    stopped.controller.abort();
    assert.equal(f.permissions("stopped").length, 2);
    assert.equal(await f.session.answerPermission!("sibling-call", "allow"), true);
    assert.equal((await sibling.result).behavior, "allow");
  });
}

for (const producer of [undefined, "child"]) {
  it(`honours SDK AbortSignal cancellation for a pending ${producer ?? "parent"} permission without granting stale answers`, async (t) => {
    const f = await permissionFixture(t);
    if (producer) await f.spawn(producer);
    const cancelled = f.request("cancelled", producer);
    assert.equal(getEventListeners(cancelled.controller.signal, "abort").length, 1);
    cancelled.controller.abort();
    assert.equal((await cancelled.result).behavior, "deny");
    assert.equal(getEventListeners(cancelled.controller.signal, "abort").length, 0);
    assert.deepEqual(f.permissions("cancelled").map((event) => event.type === "permission" && event.state), ["asked", "aborted"]);
    assert.equal(await f.session.answerPermission!("cancelled", "always"), false);
    assert.equal(await f.session.answerPermission!("cancelled", "allow"), false);
    assert.equal(await f.session.answerPermission!("cancelled", "deny"), false);
    const next = f.request("next", producer);
    assert.equal(f.permissions("next").length, 1, "cancellation neither refuses nor grants the tool");
    assert.equal(await f.session.answerPermission!("next", "allow"), true);
    assert.equal((await next.result).behavior, "allow");
    assert.equal(await f.session.answerPermission!("next", "always"), false);
    next.controller.abort();
    assert.equal(f.permissions("next").length, 2, "cancellation after a decision has no second terminal event");
    const afterDuplicate = f.request("after-duplicate", producer);
    assert.equal(f.permissions("after-duplicate").length, 1, "duplicate Always must not grant either");
    afterDuplicate.controller.abort();
    assert.equal((await afterDuplicate.result).behavior, "deny");
  });
}

it("does not ask or allow an already cancelled SDK permission", async (t) => {
  const f = await permissionFixture(t);
  const controller = new AbortController();
  controller.abort();
  const cancelled = f.request("pre-cancelled", undefined, controller);
  assert.equal((await cancelled.result).behavior, "deny");
  assert.deepEqual(f.permissions("pre-cancelled"), []);
  assert.equal(await f.session.answerPermission!("pre-cancelled", "always"), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await f.session.setPermissionMode!("always");
  assert.equal((await f.request("pre-cancelled-always", undefined, controller).result).behavior, "deny");
  assert.deepEqual(f.permissions("pre-cancelled-always"), []);
});

it("disposal settles parent and detached requests and removes all cancellation listeners", async (t) => {
  const f = await permissionFixture(t);
  await f.spawn("child");
  await f.finish();
  const child = f.request("child-call", "child");
  const parent = f.request("parent-call");
  await f.session.dispose();
  await f.session.dispose();
  for (const [id, request] of [["child-call", child], ["parent-call", parent]] as const) {
    assert.equal((await request.result).behavior, "deny");
    assert.equal(getEventListeners(request.controller.signal, "abort").length, 0);
    assert.equal(await f.session.answerPermission!(id, "always"), false);
    request.controller.abort();
    assert.equal(f.permissions(id).length, 2);
  }
  const late = f.request("after-disposal", "child");
  assert.equal((await late.result).behavior, "deny");
  assert.deepEqual(f.permissions("after-disposal"), []);
});

it("stream failure settles parent and detached requests, with idempotent cleanup", async (t) => {
  const f = await permissionFixture(t);
  await f.spawn("child");
  const child = f.request("child-call", "child");
  const parent = f.request("parent-call");
  f.fail();
  await drain();
  for (const [id, request] of [["child-call", child], ["parent-call", parent]] as const) {
    assert.equal((await request.result).behavior, "deny");
    assert.equal(getEventListeners(request.controller.signal, "abort").length, 0);
    assert.equal(await f.session.answerPermission!(id, "always"), false);
    request.controller.abort();
    assert.equal(f.permissions(id).length, 2);
  }
  await f.session.dispose();
  assert.equal(f.permissions("child-call").length, 2);
  assert.equal(f.permissions("parent-call").length, 2);
});

it("keeps explicit parent abort's existing all-prompts semantics for the shared CLI", async (t) => {
  const f = await permissionFixture(t);
  await f.spawn("child");
  const child = f.request("child-call", "child");
  const parent = f.request("parent-call");
  await f.session.abort();
  assert.equal(f.interrupts(), 1);
  for (const [id, request] of [["child-call", child], ["parent-call", parent]] as const) {
    assert.equal((await request.result).behavior, "deny");
    assert.equal(getEventListeners(request.controller.signal, "abort").length, 0);
    assert.equal(await f.session.answerPermission!(id, "always"), false);
  }
  await f.finish();
  assert.equal(f.permissions("child-call").length, 2);
  assert.equal(f.permissions("parent-call").length, 2);
});

it("the pinned SDK's native Auto classifier allows and denies tools", { timeout: 30000 }, async () => {
  const allowed = await runNativeAutoScenario("allow");
  assert.ok(allowed.classifierRequests >= 1, "the native classifier must inspect the allowed command");
  assert.deepEqual(allowed.permissionCallbacks, []);
  assert.ok(allowed.messages.some((message) => message.type === "user" && JSON.stringify(message).includes('"content":"42"')),
    "the classifier-allowed command must execute");
  assert.ok(!allowed.messages.some((message) => message.type === "system" && message.subtype === "permission_denied"));

  const denied = await runNativeAutoScenario("deny");
  assert.ok(denied.classifierRequests >= 2, "a block must traverse both native classifier stages");
  assert.deepEqual(denied.permissionCallbacks, [], "native Auto denial must not be replaced by Flow policy");
  assert.ok(denied.messages.some((message) => message.type === "system" && message.subtype === "permission_denied" && message.decision_reason_type === "classifier"));
  const denialResult = denied.messages.find((message) => message.type === "result") as (SDKMessage & { permission_denials?: unknown[] }) | undefined;
  assert.ok(denialResult?.permission_denials?.length, "the SDK result must retain its authoritative denial evidence");
});

it("surfaces that pinned SDK native Auto cannot deterministically escalate the Subagent safety probe", { timeout: 30000 }, async () => {
  const result = await runNativeAutoSubagentIncompatibilityScenario();
  assert.deepEqual(result.permissionModes, ["auto"], "the SDK must stay in Auto for the ordinary Agent turn");
  assert.ok(result.classifierRequests >= 2, "native Auto must classify the Agent launch and child Bash call");
  assert.deepEqual(result.permissionCallbacks, [],
    "SDK 0.3.247 classifier-routes the background safety probe instead of exposing a human callback");
  assert.equal(result.events.some((event) => event.type === "permission"), false,
    "without an Ask rule, Flow receives no native escalation to attribute or answer");
  assert.equal(result.executed, true,
    "execution evidence must come from tool_result content, demonstrating that the classifier allowed the harmless probe");
});

it("Claude's pinned SDK sends native Auto through its control protocol and reports rejection, not a local substitute", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "flow-claude-permission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "commands.jsonl");
  const executable = join(root, "cli.js");
  writeFileSync(executable, `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'control_request') return;
  fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify(request.request) + '\\n');
  const rejected = request.request.subtype === 'set_permission_mode' && process.env.FLOW_REJECT_AUTO === '1';
  process.stdout.write(JSON.stringify({ type: 'control_response', response: {
    subtype: rejected ? 'error' : 'success', request_id: request.request_id,
    ...(rejected ? { error: 'Auto unavailable' } : { response: { models: [{ value: 'opus', displayName: 'Opus', description: '' }] } }),
  } }) + '\\n');
});
`);
  const backend = new ClaudeBackend({ pathToClaudeCodeExecutable: executable, allowedTools: [] });
  const session = await backend.create({ scope: root, emit: () => {}, permissionMode: "auto" });
  const controls = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { subtype: string; mode?: string });
  assert.ok(controls.some((command) => command.subtype === "set_permission_mode" && command.mode === "auto"));
  await session.setPermissionMode?.("ask");
  const after = readFileSync(output, "utf8");
  assert.ok(after.includes('"mode":"default"'));
  await session.dispose();
  const previous = process.env.FLOW_REJECT_AUTO;
  process.env.FLOW_REJECT_AUTO = "1";
  try {
    await assert.rejects(backend.create({ scope: root, emit: () => {}, permissionMode: "auto" }), AutoPermissionUnavailable);
  } finally {
    if (previous === undefined) delete process.env.FLOW_REJECT_AUTO; else process.env.FLOW_REJECT_AUTO = previous;
  }
});
