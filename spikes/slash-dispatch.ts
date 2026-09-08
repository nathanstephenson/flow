/**
 * Manual probe: find out what the Claude SDK does with a prompt that begins with a slash.
 *
 * The question this answers is load-bearing. `Query` exposes no `compact()`, but `SDKMessage`'s
 * compaction boundary reports `trigger: "manual"` — so *something* triggers one, and the only
 * channel left is the prompt. If a leading slash is dispatched locally by the CLI, that is how the
 * Claude adapter has to ask for a compaction. If it is not, the adapter cannot serve one at all and
 * should say so through `capabilities.compaction` rather than sending the model the word "/compact".
 *
 * Two signals, either of which settles it:
 *
 *   - **A local command never reaches the model.** `result.usage.input_tokens` stays at zero and
 *     `num_turns` does not advance. A prompt does the opposite.
 *   - **An unknown command is refused locally.** `/definitely-not-a-command-xyz` comes back as an
 *     error or a `system`/`local_command_output` if the CLI is parsing it, and as an ordinary
 *     answer if the model is reading it.
 *
 * Both are near-free: an empty conversation has nothing to compact and nothing to answer.
 *
 *   node --experimental-strip-types spikes/slash-dispatch.ts ['<prompt>']
 *
 * Pass `--broken-credentials` to make the auth failure itself the signal: a local command that
 * fails *before* the auth check proves dispatch without any credentials being valid at all.
 *
 * ## What it answered, 2026-09
 *
 * Local dispatch, unambiguously. Both probes, with credentials deliberately broken:
 *
 *     /compact                       → "Error: No messages to compact"
 *     /definitely-not-a-command-xyz  → "Unknown command: /definitely-not-a-command-xyz"
 *     both: turns=0 input_tokens=0
 *
 * Nothing was billed and no credential was ever checked, so the CLI parsed and ran both before any
 * request existed. `"/compact"` in the prompt channel is therefore how the Claude adapter asks for a
 * compaction, and `capabilities.compaction: true` is honest for it.
 *
 * **The wrinkle worth knowing:** a local command's output comes back as an ordinary `assistant`
 * message, not as `system`/`local_command_output`. So a refused compaction ("No messages to
 * compact") would otherwise land in the Presentation Transcript as though the model had said it.
 * Whatever sends the command has to account for that; see the Claude adapter's `compact()`.
 */
import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const broken = process.argv.includes("--broken-credentials");
// Several prompts run in order down one session, which is how the *successful* path gets probed:
// an empty conversation has nothing to compact, so it takes a real turn first to make one.
const prompts = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (prompts.length === 0) prompts.push("/compact");

if (broken) {
  process.env.ANTHROPIC_API_KEY = "sk-ant-definitely-not-a-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "";
}

const one = async function* (): AsyncGenerator<SDKUserMessage> {
  for (const text of prompts) {
    console.log(`--- sending ${JSON.stringify(text)}`);
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    } as SDKUserMessage;
  }
};

const options: Options = {
  cwd: process.cwd(),
  permissionMode: "default",
  // Nothing may run. A local command that shells out is still a local command, and a model talked
  // into using a tool here would muddy the reading.
  allowedTools: [],
  canUseTool: async (toolName: string) => ({
    behavior: "deny" as const,
    message: `${toolName} is not enabled for this probe.`,
  }),
};

console.log(`prompts: ${prompts.map((text) => JSON.stringify(text)).join(", ")}`);
console.log(broken ? "credentials deliberately broken\n" : "");

const stream = query({ prompt: one(), options });
const timeout = setTimeout(() => {
  console.log("\ntimed out after 90s");
  process.exit(1);
}, 90_000);

for await (const message of messages(stream)) describe(message);
clearTimeout(timeout);

async function* messages(source: AsyncIterable<SDKMessage>): AsyncGenerator<SDKMessage> {
  try {
    for await (const message of source) yield message;
  } catch (error) {
    console.log(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function describe(message: SDKMessage): void {
  const subtype = "subtype" in message ? `/${message.subtype}` : "";
  const head = `${message.type}${subtype}`;

  if (message.type === "system" && message.subtype === "compact_boundary") {
    console.log(`${head}  ${JSON.stringify(message.compact_metadata)}`);
    console.log("\n→ LOCAL DISPATCH. The CLI ran the command; the model never saw the text.");
    return;
  }
  if (message.type === "system" && message.subtype === "local_command_output") {
    console.log(`${head}  ${JSON.stringify(message.content)}`);
    console.log("\n→ LOCAL DISPATCH. The CLI produced this output itself.");
    return;
  }
  if (message.type === "assistant") {
    const first = message.message.content.find((block) => block.type === "text");
    console.log(`${head}  ${JSON.stringify(first && "text" in first ? first.text.slice(0, 120) : "")}`);
    return;
  }
  if (message.type === "result") {
    const usage = "usage" in message ? message.usage : undefined;
    const input = usage?.input_tokens ?? 0;
    console.log(`${head}  turns=${message.num_turns} input_tokens=${input}`);
    console.log(
      input === 0
        ? "\n→ LOCAL DISPATCH. Nothing was billed, so nothing was sent to the model."
        : "\n→ PROMPT. The text was billed as input, so the model read it as a message.",
    );
    return;
  }
  console.log(head);
}
