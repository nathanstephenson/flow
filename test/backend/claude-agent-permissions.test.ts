import assert from "node:assert/strict";
import { it } from "node:test";
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
