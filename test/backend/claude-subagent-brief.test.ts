import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { query, type Options, type Query, type SDKMessage, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

async function fixture(t: TestContext) {
  let launch!: Options;
  const events: BackendEvent[] = [];
  const messages = new AsyncQueue<SDKMessage>();
  const backend = new ClaudeBackend({ allowedTools: [], query: ((args: Parameters<typeof query>[0]) => {
    launch = args.options!;
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => [
        { value: "opus", resolvedModel: "claude-opus-5", supportedEffortLevels: ["low", "high"] },
        { value: "haiku", resolvedModel: "claude-haiku-4-5" },
      ],
      supportedAgents: async () => [{ name: "Explore", description: "", model: "haiku" }, { name: "general-purpose", description: "", model: "inherit" }],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      setPermissionMode: async () => {},
      close: () => messages.close(),
    } as unknown as Query;
  }) as typeof query });
  const session = await backend.create({ scope: "/tmp", modelId: "opus", emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  const push = async (message: unknown) => {
    messages.push(message as SDKMessage);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const spawn = (id: string, input: object, parent: string | null = null) => push({
    type: "assistant", parent_tool_use_id: parent, session_id: "s", uuid: `a-${id}`,
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Agent", input: { description: id, prompt: "p", ...input } }] },
  });
  const last = (id: string) => events.findLast((event): event is Extract<BackendEvent, { type: "subagent" }> =>
    event.type === "subagent" && event.subagentId === id);
  await push({ type: "system", subtype: "init", session_id: "s", model: "claude-opus-5", effort: "high" });
  return { launch, push, spawn, last };
}

it("reports the model and effort a Subagent starts with", async (t) => {
  const f = await fixture(t);
  await f.spawn("inherits", { subagent_type: "general-purpose" });
  await f.spawn("defined", { subagent_type: "Explore" });
  await f.spawn("asked", { subagent_type: "general-purpose", model: "sonnet" });
  assert.deepEqual(f.last("inherits"), { type: "subagent", subagentId: "inherits", name: "general-purpose", description: "inherits", model: "opus", effort: "high", state: "running" });
  assert.equal(f.last("defined")?.model, "haiku");
  assert.equal(f.last("asked")?.model, "sonnet");
});

it("gives a nested Subagent the model and effort of the Subagent that spawned it", async (t) => {
  const f = await fixture(t);
  await f.spawn("parent", { subagent_type: "general-purpose", model: "sonnet", effort: "low" });
  await f.spawn("child", { subagent_type: "general-purpose" }, "parent");
  assert.deepEqual(f.last("child"), { type: "subagent", subagentId: "child", name: "general-purpose", description: "child",
    model: "sonnet", effort: "low", producer: { subagentId: "parent" }, state: "running" });
});

it("corrects the model from the resolved model the Agent result reports", async (t) => {
  const f = await fixture(t);
  await f.spawn("background", { subagent_type: "general-purpose" });
  await f.push({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "background", content: "launched" }] },
    tool_use_result: { status: "async_launched", resolvedModel: "claude-haiku-4-5" } });
  assert.deepEqual(f.last("background"), { type: "subagent", subagentId: "background", name: "general-purpose", description: "background", model: "haiku", effort: "high", state: "running" });
  await f.spawn("foreground", { subagent_type: "general-purpose" });
  await f.push({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "foreground", content: "done" }] },
    tool_use_result: { status: "completed", resolvedModel: "claude-opus-9" } });
  assert.equal(f.last("foreground")?.model, "claude-opus-9");
  assert.equal(f.last("foreground")?.state, "complete");
});

it("corrects the effort from the level the Subagent's own tool calls report", async (t) => {
  const f = await fixture(t);
  await f.spawn("child", { subagent_type: "general-purpose" });
  await f.push({ type: "system", subtype: "task_started", task_id: "task-child", tool_use_id: "child" });
  const hook = f.launch.hooks?.PreToolUse?.find((matcher) => matcher.matcher === undefined)?.hooks[0];
  assert.ok(hook);
  const input: PreToolUseHookInput = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "read",
    session_id: "s", transcript_path: "unused", cwd: "/tmp", agent_id: "task-child", effort: { level: "low" } };
  assert.deepEqual(await hook(input, undefined, { signal: new AbortController().signal }), {});
  assert.deepEqual(f.last("child"), { type: "subagent", subagentId: "child", name: "general-purpose", description: "child", model: "opus", effort: "low", state: "running" });
});
