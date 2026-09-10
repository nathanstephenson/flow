/**
 * Reconnaissance, not a smoke test: how does the CLI report a backgrounded tool call that is *not*
 * a Subagent?
 *
 *   node --experimental-strip-types spikes/background-call-messages.ts
 *   node --experimental-strip-types spikes/background-call-messages.ts --monitor
 *
 * ADR 0016 left one question open — whether such a call deserves a lifecycle Entry of its own — and
 * asserted in passing that a backgrounded `Bash` or `Monitor` "settles through the same
 * `task_started` / `task_notification` messages". That assertion is what a card would be built on
 * and it has never been captured, so this captures it.
 *
 * The detector is the real question. `isAsyncLaunch` reads `tool_use_result.status`, but the shape
 * it was written against is the `Agent` tool's own `AgentOutput` — `{ status, isAsync, agentId,
 * outputFile }` — and there is no reason a backgrounded shell should answer in that vocabulary. So
 * every `tool_use_result` is printed whole rather than probed for the one field we hope is there.
 *
 * What the capture has to answer, in this order:
 *   1. Which message marks the call as backgrounded, and is its `callId` recoverable from it?
 *   2. Which message settles it?
 *   3. Does `isAsyncLaunch` fire at all — or is the detector "a `task_started` whose `tool_use_id`
 *      is not a Subagent's"?
 *
 * Deliberately talks to the SDK directly rather than through ClaudeSession, for the reason
 * `background-result-attribution.ts` gives: the adapter throws away everything this needs to see.
 *
 * ## What it captured, at CLI 2.1.247
 *
 * **`isAsyncLaunch` never fires, and no receipt-shaped detector can replace it.** Neither launch
 * receipt carries a `status` field, and the two do not even agree with each other on what they do
 * carry:
 *
 *     Bash    tool_use_result={"stdout":"","stderr":"","interrupted":false,…,"backgroundTaskId":"b0m1k9r1r"}
 *     Monitor tool_use_result={"taskId":"bqi5g1ccj","timeoutMs":3600000,"persistent":false}
 *
 * `backgroundTaskId` against `taskId`. A detector reading the receipt would need to know both field
 * names, and a third for the next tool — a tool-name allowlist wearing a different hat.
 *
 * **`task_started` is the signal, and it is uniform.** Both runs produced, identically shaped:
 *
 *     system/task_started task=b0m1k9r1r tool_use=toolu_016svu (Bash)
 *     system/task_started task=bqi5g1ccj tool_use=toolu_01Vb56 (Monitor)
 *
 * Both ids on one message, for a plain tool call. So *"a `task_started` whose `tool_use_id` is not
 * a Subagent's"* is the whole detector, it reads no tool-specific field, and ADR 0016's passing
 * assertion that these calls "settle through the same messages" is confirmed.
 *
 * **It arrives before the launch receipt** — 9.2s against 9.3s for Bash, 9.4s against 9.5s for
 * Monitor — so the bookkeeping must accept a callId it has only seen announced, never one it has
 * already watched return.
 *
 * **The settle arrives twice, and `task_updated` comes first:**
 *
 *     +54.3s system/task_updated      task=b0m1k9r1r no tool_use_id patch={"status":"completed",…}
 *     +54.3s system/task_notification task=b0m1k9r1r tool_use=toolu_016svu status=completed
 *
 * Which is why the `task_id`→`callId` map is not optional — `task_updated` carries no `tool_use_id`
 * at all — and why settling must be idempotent: the second message must not emit a second terminal
 * snapshot.
 *
 * **`system/background_tasks_changed` is new and useless here.** It brackets both the launch and the
 * settle and carries neither id, so there is nothing to key on.
 *
 * **Reaching `Monitor` at all needed `bypassPermissions`.** It is absent from Flow's
 * `DEFAULT_ALLOWED_TOOLS`, so under the adapter's own `permissionMode` it raises a Permission Prompt
 * per call. Left alone deliberately — ADR 0016 closed with "no tool was added to let the model
 * poll" — and recorded as a consequence in ADR 0021 rather than quietly fixed.
 */
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const started = Date.now();
const at = () => `+${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s`;

/** Streaming input, so a second prompt can be pushed while the backgrounded call is still running. */
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
 * `--monitor` runs the same capture against the `Monitor` tool instead of a backgrounded `Bash`.
 *
 * Two runs rather than one prompt asking for both: `Monitor` is absent from Flow's
 * `DEFAULT_ALLOWED_TOOLS`, so it needs `permissionMode: "bypassPermissions"` here to be reachable
 * at all — which is itself worth knowing, and is not a mode the adapter would ever use.
 */
const monitor = process.argv.includes("--monitor");

push(
  monitor
    ? "Use the Monitor tool to watch for the file /tmp/spike-sentinel to exist, with a generous " +
        "timeout. Reply immediately after launching it; do not wait for it."
    : "Run `sleep 45 && echo done` with the Bash tool and run_in_background: true. Reply " +
        "immediately after launching it; do not wait for it.",
);

const stream = query({
  prompt: prompts(),
  options: {
    cwd: process.cwd(),
    // Not "default": an unapproved tool would stall this capture on a prompt nothing here answers.
    permissionMode: "bypassPermissions",
    allowedTools: monitor ? ["Monitor", "Read", "Glob"] : ["Bash", "BashOutput", "KillShell"],
  },
});

/** Every `tool_use` block seen, so a later message's `tool_use_id` can be named rather than guessed. */
const names = new Map<string, string>();
let results = 0;
let steered = false;
let launched = false;

for await (const sdkMessage of stream as AsyncIterable<SDKMessage>) {
  const m = sdkMessage as SDKMessage & Record<string, unknown>;
  const parent = (m.parent_tool_use_id as string | null | undefined) ?? null;
  const tag = parent ? ` parent=${parent.slice(0, 12)}` : "";

  if (m.type === "system") {
    const sub = String(m.subtype);
    if (sub === "init") continue;
    const callId = m.tool_use_id ? String(m.tool_use_id) : undefined;
    // Question 1: whether the message that marks the launch names the call it launched.
    const extra = [
      m.task_id ? `task=${String(m.task_id).slice(0, 14)}` : "",
      callId ? `tool_use=${callId.slice(0, 12)} (${names.get(callId) ?? "UNKNOWN CALL"})` : "no tool_use_id",
      m.status ? `status=${String(m.status)}` : "",
      m.patch ? `patch=${JSON.stringify(m.patch)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`${at()}  system/${sub} ${extra}`);
    continue;
  }

  if (m.type === "assistant") {
    const content = (m.message as { content: { type: string; id?: string; name?: string; input?: unknown }[] })
      .content;
    for (const block of content) {
      if (block.type !== "tool_use" || !block.id) continue;
      names.set(block.id, block.name ?? "?");
      console.log(`${at()}  tool_use ${block.id.slice(0, 12)} ${block.name} ${JSON.stringify(block.input)}`);
    }
    const kinds = content.map((b) => (b.type === "tool_use" ? `tool_use:${b.name ?? "?"}` : b.type)).join(",");
    console.log(`${at()}  assistant${tag} [${kinds}]`);
    continue;
  }

  if (m.type === "user") {
    const content = m.message as { content: unknown };
    const blocks = Array.isArray(content.content) ? content.content : [];
    for (const block of blocks as { type?: string; tool_use_id?: string }[]) {
      if (block.type !== "tool_result") continue;
      const callId = block.tool_use_id ?? "";
      // Question 3, whole rather than probed: whatever shape this is, it is the shape a detector
      // keyed on the receipt would have to read.
      console.log(
        `${at()}  tool_result ${callId.slice(0, 12)} (${names.get(callId) ?? "?"})` +
          ` tool_use_result=${JSON.stringify(m.tool_use_result)}`,
      );
      if ((m.tool_use_result as { status?: string } | undefined)?.status !== undefined) launched = true;
    }
    if (blocks.length === 0) console.log(`${at()}  user${tag} (no tool_result blocks)`);
    continue;
  }

  if (m.type === "result") {
    results += 1;
    console.log(
      `${at()}  RESULT #${results} subtype=${String(m.subtype)}` +
        ` terminal_reason=${JSON.stringify(m.terminal_reason)} num_turns=${JSON.stringify(m.num_turns)}`,
    );
    // Steer once the launch has happened, so a turn is open while the call runs — the same shape
    // `background-result-attribution.ts` uses, and the way to see whether a settling call collides
    // with a turn it did not start.
    if (!steered) {
      steered = true;
      console.log(`${at()}  >> steering while the backgrounded call runs`);
      push("What is 2+2? Answer with just the number.");
      continue;
    }
    // Nothing to do but wait for the settle. The capture is worthless without question 2.
    if (results >= 6) break;
    continue;
  }

  if (m.type === "stream_event") continue;
  console.log(`${at()}  ${m.type}${tag}`);
}

closed = true;
wake?.();
console.log(`\nlaunch receipt carried a status field: ${launched}`);
console.log(`total result messages: ${results}`);
await (stream as unknown as { close?: () => Promise<void> }).close?.();
