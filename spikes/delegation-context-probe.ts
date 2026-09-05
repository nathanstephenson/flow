/**
 * Manual probe: does getContextUsage account for a Delegation's tokens, and what is the
 * delegation-spawning tool actually called?
 *
 * Drives the SDK directly rather than through ClaudeBackend, because describeContextUsage keeps only
 * totalTokens and maxTokens — the two fields that cannot distinguish "already counted" from "not".
 *
 * getContextUsage must be called while the stream is open: asking after the `result` message fails
 * with "Query closed before response received".
 *
 *   npx tsx spikes/delegation-context-probe.ts
 */
import { writeFileSync } from "node:fs";

import { query } from "@anthropic-ai/claude-agent-sdk";

const stream = query({
  prompt:
    "Spawn a subagent to read package.json and report the \"name\" field, then tell me what it said. " +
    "Use whichever tool spawns a subagent. Keep it brief.",
  options: {
    cwd: process.cwd(),
    permissionMode: "default",
    allowedTools: ["Task", "Agent", "Read", "Glob", "Grep"],
  },
});

const snapshots: Record<string, unknown> = {};
const snapshot = async (label: string): Promise<void> => {
  try {
    const usage = await stream.getContextUsage();
    snapshots[label] = usage;
    const u = usage as { totalTokens?: number; agents?: unknown[] };
    console.log(`[${label}] totalTokens=${u.totalTokens} keys=${Object.keys(usage).join(",")}`);
  } catch (error) {
    console.log(`[${label}] unavailable: ${String(error)}`);
  }
};

const toolNames: string[] = [];
let delegationCallId: string | undefined;

for await (const sdkMessage of stream) {
  const parent = (sdkMessage as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;

  if (sdkMessage.type === "system" && sdkMessage.subtype === "init") await snapshot("baseline");

  if (sdkMessage.type === "assistant") {
    for (const block of sdkMessage.message.content) {
      if (block.type === "tool_use") {
        toolNames.push(block.name);
        console.log(`tool_use name=${block.name} id=${block.id} parent=${String(parent)}`);
        // Whatever spawned a child is the delegation tool: its id is what children are attributed to.
        if (!parent) delegationCallId = block.id;
      }
    }
    if (parent) console.log(`  assistant attributed to ${parent}`);
  }

  // The Delegation has returned by the time its tool_result lands, and the stream is still open.
  if (sdkMessage.type === "user" && Array.isArray(sdkMessage.message.content)) {
    for (const block of sdkMessage.message.content) {
      if (block.type === "tool_result" && block.tool_use_id === delegationCallId) {
        await snapshot("after the Delegation returned");
      }
    }
  }

  if (sdkMessage.type === "result") {
    console.log(`result subtype=${sdkMessage.subtype} parent=${String(parent)}`);
  }
}

writeFileSync("/tmp/ctx-usage.json", JSON.stringify(snapshots, null, 2));
console.log(`\ntool names seen: ${JSON.stringify(toolNames)}`);
console.log("full snapshots written to /tmp/ctx-usage.json");
