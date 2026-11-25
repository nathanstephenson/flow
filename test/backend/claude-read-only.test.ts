import assert from "node:assert/strict";
import { it } from "node:test";
import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import type { ReadOnlyScope } from "../../src/backend/types.ts";

function backend(launches: Options[]) {
  return new ClaudeBackend({ query: ((args: Parameters<typeof query>[0]) => {
    const messages = new AsyncQueue<SDKMessage>();
    launches.push(args.options!);
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => [{ value: "sonnet", supportedEffortLevels: ["high"] }],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      interrupt: async () => {},
      close: () => messages.close(),
    } as unknown as Query;
  }) as typeof query });
}

const call = (canUseTool: NonNullable<Options["canUseTool"]>, tool: string) => canUseTool(tool, {}, {
  toolUseID: `call-${tool}`, requestId: "request", signal: AbortSignal.timeout(1000), suggestions: [],
});

for (const [readOnly, denied, kept] of [
  ["mounted", ["Write", "Edit", "NotebookEdit"], ["Bash", "Read"]],
  ["tools", ["Write", "Edit", "NotebookEdit", "Bash"], ["Read"]],
] as [ReadOnlyScope, string[], string[]][]) {
  it(`a ${readOnly} read-only Scope removes and hard-denies writing tools, also for Workflow Subagents`, async () => {
    const launches: Options[] = [];
    const session = await backend(launches).create({ scope: "/tmp", readOnly, permissionMode: "always",
      standingAuthorisations: denied, emit: () => {} });
    try {
      const launch = launches[0]!;
      for (const tool of denied) {
        assert.ok(launch.disallowedTools?.includes(tool), tool);
        assert.equal(launch.allowedTools?.includes(tool), false, tool);
        assert.equal((await call(launch.canUseTool!, tool))!.behavior, "deny", tool);
      }
      for (const tool of kept) {
        assert.equal(launch.disallowedTools?.includes(tool) ?? false, false, tool);
        assert.equal((await call(launch.canUseTool!, tool))!.behavior, "allow", tool);
      }
      assert.equal(launch.enableFileCheckpointing, undefined);
      assert.equal(session.capabilities.rewindFiles, false);
      const handle = session.startWorkflowSubagent!({ id: "step", name: "Step", instructions: "Do it", input: {},
        modelId: "sonnet", effort: "high", permissionMode: "auto-accept", emit: () => {} });
      while (launches.length < 2) await new Promise((resolve) => setImmediate(resolve));
      for (const tool of denied) assert.ok(launches[1]!.disallowedTools?.includes(tool), tool);
      void handle.done.catch(() => {});
    } finally { await session.dispose(); }
  });
}

it("a writable Scope keeps writing tools and file checkpoints", async () => {
  const launches: Options[] = [];
  const session = await backend(launches).create({ scope: "/tmp", emit: () => {} });
  try {
    assert.equal(launches[0]!.disallowedTools, undefined);
    assert.equal(launches[0]!.enableFileCheckpointing, true);
    assert.equal(session.capabilities.rewindFiles, true);
  } finally { await session.dispose(); }
});
