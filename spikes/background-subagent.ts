/**
 * Manual capture: drive the Claude adapter through a backgrounded Subagent and print the Agent
 * Events in order, so ADR 0016's claims can be checked against what the CLI actually emits.
 *
 *   node --experimental-strip-types spikes/background-subagent.ts
 *
 * Deliberately not an `npm run` script: `package.json` is in build-assets' HASH_INPUTS, so adding
 * one there fails the embedded-bundle staleness gate until the assets are rebuilt.
 *
 * What to look for, in order:
 *   subagent(running) -> tool_ended(Agent) -> turn_ended   ... the launch, freeing the turn
 *   turn_started                                            ... minted when the model is woken
 *   subagent(complete)                                      ... the notification closing the card
 */
import { ClaudeBackend } from "../src/backend/claude/index.ts";
import type { BackendEvent } from "../src/protocol/events.ts";

const backend = new ClaudeBackend();
const seen: BackendEvent[] = [];
let settled: (() => void) | undefined;
const done = new Promise<void>((resolve) => {
  settled = resolve;
});

const session = await backend.create({
  scope: process.cwd(),
  emit: (event) => {
    seen.push(event);
    const at = new Date().toISOString().slice(11, 19);
    if (event.type === "subagent") {
      console.log(`${at}  subagent(${event.state}) ${event.name} [${event.subagentId.slice(0, 12)}]`);
    } else if (event.type === "tool_started" || event.type === "tool_ended") {
      const name = event.type === "tool_started" ? event.name : "";
      const producer = event.producer ? ` via ${event.producer.subagentId.slice(0, 12)}` : "";
      console.log(`${at}  ${event.type} ${name}${producer} [${event.callId.slice(0, 12)}]`);
    } else if (event.type === "turn_started" || event.type === "turn_ended") {
      console.log(`${at}  ${event.type} [${event.turnId.slice(0, 8)}]`);
    } else if (event.type === "message" && event.final) {
      const producer = event.producer ? " (subagent)" : "";
      console.log(`${at}  message${producer} ${JSON.stringify(event.text.slice(0, 80))}`);
    } else if (event.type === "notice") {
      console.log(`${at}  notice[${event.level}] ${event.text.slice(0, 120)}`);
    }
    // The card closing is the end of the story, not the first turn_ended.
    if (event.type === "subagent" && event.state !== "running" && event.state !== "waiting") settled?.();
  },
});

await session.prompt(
  "Launch exactly one background agent (the Agent tool with run_in_background: true, " +
    "subagent_type Explore) to count the files in ./docs. Do not wait for it before replying.",
);

await Promise.race([
  done,
  new Promise((_, reject) => setTimeout(() => reject(new Error("no terminal subagent snapshot in 240s")), 240_000)),
]);

// The card closing is not the end: the CLI may still wake the model with the notification, and the
// turn minted for what it then says is the half of ADR 0016 the launch alone does not exercise.
console.log("\n-- lingering 45s for a re-invocation --");
await new Promise((resolve) => setTimeout(resolve, 45_000));

const order = seen
  .filter((e) => e.type === "turn_started" || e.type === "turn_ended" || e.type === "subagent")
  .map((e) => (e.type === "subagent" ? `subagent:${e.state}` : e.type));
console.log("\nlifecycle order:", order.join(" -> "));
const turns = new Set(seen.filter((e) => e.type === "turn_started").map((e) => e.turnId));
console.log(`turns minted: ${turns.size}`);

await session.dispose();
console.log("disposed cleanly");
