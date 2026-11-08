import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { runningWork } from "./running-work.ts";

const entries: Entry[] = [
  { kind: "tool", id: "c1", name: "Bash", input: { command: "npm test" }, status: "complete" },
  { kind: "background_call", id: "c1", tool: "Bash", status: "running", startedAt: "t" },
  { kind: "subagent", id: "s1", name: "reviewer", description: "Review the diff", status: "running" },
  { kind: "subagent", id: "s2", name: "done", status: "complete" },
  { kind: "background_call", id: "c2", tool: "Bash", status: "complete", startedAt: "t" },
  { kind: "background_call", id: "c3", tool: "Bash", status: "running", startedAt: "t", producer: { subagentId: "s1" } },
] as Entry[];
const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]));

describe("the work running beside a turn", () => {
  it("lists running Subagents and the parent's running Background Calls, oldest first", () => {
    assert.deepEqual(runningWork([...byKey.keys()], (key) => byKey.get(key)), [
      { kind: "call", key: "tool:c1", tool: "Bash", detail: "npm test" },
      { kind: "agent", key: "subagent:s1", name: "reviewer", detail: "Review the diff" },
    ]);
  });

  it("is empty when nothing is running", () => {
    assert.deepEqual(runningWork(["subagent:s2", "background_call:c2"], (key) => byKey.get(key)), []);
  });
});
