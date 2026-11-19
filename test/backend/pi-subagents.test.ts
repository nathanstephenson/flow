import assert from "node:assert/strict";
import { it } from "node:test";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { subagentTool } from "../../src/backend/pi/subagents.ts";
import { PiWork, textResult } from "../../src/backend/pi/work.ts";

it("names the spawning Subagent as producer on a nested Subagent's snapshots", async () => {
  const events: BackendEvent[] = [];
  const work = new PiWork((event) => events.push(event), () => {});
  const ran: string[] = [];
  const tool = subagentTool(work, async (id) => { ran.push(id); return textResult("done"); }, { subagentId: "parent" });

  await tool.execute("spawn-1", { description: "plan", prompt: "Plan it", run_in_background: false }, new AbortController().signal, undefined, undefined as never);

  assert.deepEqual(events.map((event) => event.type === "subagent" && [event.subagentId, event.producer, event.state]), [
    ["parent/spawn-1", { subagentId: "parent" }, "running"],
    ["parent/spawn-1", { subagentId: "parent" }, "complete"],
  ]);
  assert.deepEqual(ran, ["parent/spawn-1"], "the child's own producer is the id its card carries");
});
