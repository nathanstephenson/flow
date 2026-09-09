/**
 * Reconnaissance, not a smoke test: does a backgrounded Subagent emit an `SDKResultMessage` on the
 * main stream, and if so is there anything on it that tells it apart from the one ending the human's
 * turn?
 *
 *   node --experimental-strip-types spikes/background-result-attribution.ts
 *
 * ADR 0016 records this as the one unverified risk. If a detached Subagent's `result` reaches
 * `finishTurn` while a steered turn is open, it ends that turn early — the human's message would
 * look answered when it had not been. This drives the exact shape: launch a background agent, then
 * steer a second prompt while it is still running, and print every message with the fields that
 * could possibly attribute it.
 *
 * Deliberately talks to the SDK directly rather than through ClaudeSession: the adapter throws away
 * everything this needs to see.
 */
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const started = Date.now();
const at = () => `+${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s`;

/** Streaming input, so a second prompt can be pushed while the first turn's work is still running. */
const inbox: SDKUserMessage[] = [];
let wake: (() => void) | undefined;
let closed = false;

const push = (text: string): void => {
  inbox.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage);
  wake?.();
};

async function* prompts(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    while (inbox.length > 0) yield inbox.shift() as SDKUserMessage;
    if (closed) return;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

/**
 * `--foreground` runs the same capture with a blocking Agent call, which is the case `Subagents.hold`
 * exists for: if a foreground Subagent emits no `result` of its own either, the hold is answering a
 * question nothing asks.
 */
const foreground = process.argv.includes("--foreground");

push(
  foreground
    ? "Use the Agent tool with run_in_background: false and subagent_type Explore to count the " +
        "files in ./docs. Wait for it and report what it said."
    : "Launch exactly one background agent (the Agent tool with run_in_background: true, subagent_type " +
        "Explore) to count the files in ./docs. Reply immediately; do not wait for it.",
);

const stream = query({
  prompt: prompts(),
  options: { cwd: process.cwd(), permissionMode: "default", allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent"] },
});

let results = 0;
let steered = false;
let launchSeen = false;

for await (const sdkMessage of stream as AsyncIterable<SDKMessage>) {
  const m = sdkMessage as SDKMessage & Record<string, unknown>;
  const parent = (m.parent_tool_use_id as string | null | undefined) ?? null;
  const tag = parent ? ` parent=${parent.slice(0, 12)}` : "";

  if (m.type === "system") {
    const sub = String(m.subtype);
    if (sub === "init") continue;
    const extra = [
      m.task_id ? `task=${String(m.task_id).slice(0, 14)}` : "",
      m.tool_use_id ? `tool_use=${String(m.tool_use_id).slice(0, 12)}` : "",
      m.status ? `status=${String(m.status)}` : "",
      m.is_backgrounded === undefined ? "" : `backgrounded=${String(m.is_backgrounded)}`,
      m.patch ? `patch=${JSON.stringify(m.patch)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`${at()}  system/${sub} ${extra}`);
    continue;
  }

  if (m.type === "assistant") {
    const content = (m.message as { content: { type: string; name?: string }[] }).content;
    const kinds = content
      .map((b) => (b.type === "tool_use" ? `tool_use:${b.name ?? "?"}` : b.type))
      .join(",");
    console.log(`${at()}  assistant${tag} [${kinds}]`);
    continue;
  }

  if (m.type === "user") {
    const launch = (m.tool_use_result as { status?: string } | undefined)?.status;
    console.log(`${at()}  user${tag}${launch ? ` tool_use_result.status=${launch}` : ""}`);
    if (launch === "async_launched" || (foreground && launch === "completed")) launchSeen = true;
    continue;
  }

  if (m.type === "result") {
    results += 1;
    // Every field that could conceivably attribute this result to a Subagent rather than the turn.
    console.log(
      `${at()}  RESULT #${results} subtype=${String(m.subtype)}${tag}` +
        ` terminal_reason=${JSON.stringify(m.terminal_reason)}` +
        ` has_parent_field=${"parent_tool_use_id" in m}` +
        ` subagent_stats=${JSON.stringify(m.subagent_stats)}` +
        ` num_turns=${JSON.stringify(m.num_turns)}` +
        ` uuid=${String(m.uuid).slice(0, 8)}`,
    );
    // Steer the moment the launch has happened, so the second turn is open while the agent runs.
    if (launchSeen && !steered) {
      steered = true;
      console.log(`${at()}  >> steering: "What is 2+2?" while the background agent is still running`);
      push("What is 2+2? Answer with just the number.");
      continue;
    }
    if (steered && results >= 3) break;
    continue;
  }

  if (m.type === "stream_event") continue;
  console.log(`${at()}  ${m.type}${tag}`);
}

closed = true;
wake?.();
console.log(`\ntotal result messages: ${results}`);
await (stream as unknown as { close?: () => Promise<void> }).close?.();
