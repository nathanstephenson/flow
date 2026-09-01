/** Manual smoke: drive the Claude adapter through one turn and print the Agent Events. */
import { PiBackend } from "../src/backend/pi/index.ts";
import type { BackendEvent } from "../src/protocol/events.ts";

const backend = new PiBackend({ tools: [] });
const seen: BackendEvent[] = [];
let resolveEnd: (() => void) | undefined;
const ended = new Promise<void>((resolve) => {
  resolveEnd = resolve;
});

const session = await backend.create({
  scope: process.cwd(),
  emit: (event) => {
    seen.push(event);
    if (event.type === "turn_ended") resolveEnd?.();
  },
});
console.log("capabilities:", JSON.stringify(session.capabilities));

await session.prompt("Reply with exactly: ok");
await Promise.race([
  ended,
  new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 90s")), 90_000)),
]);

for (const event of seen) {
  const detail = event.type === "message" ? ` ${JSON.stringify(event.text)} final=${event.final}` : "";
  console.log(`  ${event.type}${detail}`);
}
await session.dispose();
console.log("disposed cleanly");
