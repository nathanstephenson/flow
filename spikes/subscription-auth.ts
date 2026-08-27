/**
 * Spike 0 — does the Claude Agent SDK work on subscription credentials alone?
 *
 * Local mode assumes an engineer with a Claude subscription and NO ANTHROPIC_API_KEY can drive the
 * Agent SDK. The docs steer toward API-key auth, so this is verified rather than assumed.
 *
 * The child env is scrubbed of CLAUDE and ANTHROPIC vars so that running this from inside a Claude
 * Code session does not flatter the result. CLAUDE_CONFIG_DIR goes too; the CLI falls back to
 * ~/.claude, which is where an engineer's credentials live anyway.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const scrubbed: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT)/.test(key)) continue;
  scrubbed[key] = value;
}

const removed = Object.keys(process.env).filter((k) => !(k in scrubbed));
console.log(`scrubbed from child env: ${removed.join(", ") || "(none)"}`);
console.log(`ANTHROPIC_API_KEY in parent: ${process.env.ANTHROPIC_API_KEY ? "SET" : "unset"}`);

let sawText = false;
let model: string | undefined;

try {
  for await (const message of query({
    prompt: "Reply with exactly: ok",
    options: {
      env: scrubbed,
      cwd: process.cwd(),
      maxTurns: 1,
      allowedTools: [],
      settingSources: [],
    },
  })) {
    if (message.type === "system" && "model" in message) {
      model = String((message as { model?: unknown }).model ?? "");
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          sawText = true;
          console.log(`assistant: ${block.text.trim()}`);
        }
      }
    }
    if (message.type === "result") {
      console.log(`result: subtype=${message.subtype} turns=${message.num_turns}`);
    }
  }
} catch (error) {
  console.error("\nSPIKE 0 FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`\nSPIKE 0 ${sawText ? "PASSED" : "FAILED"} — model=${model ?? "unknown"}`);
process.exit(sawText ? 0 : 1);
