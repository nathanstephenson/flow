import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { query, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

const identity = { session_id: "sdk-session", uuid: "930a74e4-c171-4e72-ad93-d6fb58dfe6ed" } as const;

async function fixture(t: TestContext) {
  const messages = new AsyncQueue<SDKMessage>();
  const events: BackendEvent[] = [];
  const backend = new ClaudeBackend({ query: (() => ({
    [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
    supportedModels: async () => [{ value: "sonnet" }],
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
    close: () => messages.close(),
  } as unknown as Query)) as typeof query });
  const session = await backend.create({ scope: "/tmp", emit: event => events.push(event) });
  t.after(() => session.dispose());
  events.length = 0;
  const push = async (message: SDKMessage) => {
    messages.push(message);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { session, events, push };
}

for (const level of ["info", "notice", "suggestion", "warning"] as const) {
  it(`Claude reports informational ${level} messages without changing the turn`, async t => {
    const f = await fixture(t);
    await f.session.prompt("Continue");
    const before = [...f.events];
    const content = "Managed hooks could not be loaded.\nCheck the network connection.";
    await f.push({
      type: "system", subtype: "informational", level, content,
      tag: level === "warning" ? "managed_hooks_not_loaded" : "unknown-tag",
      prevent_continuation: true, ...identity,
    });
    assert.deepEqual(f.events, [...before, {
      type: "notice", level: level === "warning" ? "warn" : "info", text: content,
    }]);
  });
}

const losses = [
  { error_code: "ENOSPC", lost: ["transcript"], description: "its conversation record" },
  { error_code: "EDQUOT", lost: ["global_config"], description: "its global configuration" },
  { error_code: "ENOSPC", lost: ["transcript", "global_config"], description: "its conversation record and its global configuration" },
] as const;

for (const { error_code, lost, description } of losses) {
  it(`Claude warns about lost ${lost.join(" and ")} writes (${error_code}) without changing a completed turn`, async t => {
    const f = await fixture(t);
    await f.session.prompt("Finish");
    await f.push({ type: "result", subtype: "success", ...identity } as unknown as SDKMessage);
    const ended = f.events.filter(event => event.type === "turn_ended");
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.reason, "complete");
    const before = [...f.events];
    await f.push({
      type: "system", subtype: "session_writes_lost", error_code, lost: [...lost],
      ...(lost.some(part => part === "transcript") ? { transcript_session_ids: ["earlier-sdk-session"] } : {}),
      ...identity,
    });
    assert.deepEqual(f.events, [...before, {
      type: "notice", level: "warn", text: `Claude Code could not save ${description} (${error_code}).`,
    }]);
  });
}
