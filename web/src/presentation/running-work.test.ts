import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { nestedLabel, runningWork } from "./running-work.ts";

const entries: Entry[] = [
  { kind: "tool", id: "c1", name: "Bash", input: { command: "npm test" }, status: "complete" },
  { kind: "background_call", id: "c1", tool: "Bash", status: "running", startedAt: "t" },
  { kind: "subagent", id: "s1", name: "reviewer", description: "Review the diff", status: "running" },
  { kind: "subagent", id: "s2", name: "done", status: "complete" },
  { kind: "background_call", id: "c2", tool: "Bash", status: "complete", startedAt: "t" },
  { kind: "background_call", id: "c3", tool: "Bash", status: "running", startedAt: "t", producer: { subagentId: "s1" } },
  { kind: "assistant", id: "a1", text: "Tests are running.", final: true },
] as Entry[];
const byKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]));

describe("the work running beside a turn", () => {
  it("lists running Subagents and the parent's running Background Calls, oldest first", () => {
    assert.deepEqual(runningWork([...byKey.keys()], (key) => byKey.get(key)), [
      { kind: "call", key: "tool:c1", tool: "Bash", detail: "npm test" },
      { kind: "agent", key: "subagent:s1", name: "reviewer", detail: "Review the diff", nested: { agents: 0, calls: 1 } },
    ]);
  });

  it("leaves out a Call the agent has not written to the user since launching", () => {
    const quiet = [...byKey.keys()].filter((key) => key !== "assistant:a1");
    assert.deepEqual(runningWork(quiet, (key) => byKey.get(key)), [
      { kind: "agent", key: "subagent:s1", name: "reviewer", detail: "Review the diff", nested: { agents: 0, calls: 1 } },
    ]);
  });

  it("is empty when nothing is running", () => {
    assert.deepEqual(runningWork(["subagent:s2", "background_call:c2"], (key) => byKey.get(key)), []);
  });

  it("shows only root Subagents, counting running work anywhere below each", () => {
    const nested: Entry[] = [
      { kind: "subagent", id: "r", name: "root", status: "running" },
      { kind: "subagent", id: "k1", name: "child", status: "running", producer: { subagentId: "r" } },
      { kind: "subagent", id: "k2", name: "child", status: "complete", producer: { subagentId: "r" } },
      { kind: "subagent", id: "g", name: "grandchild", status: "waiting", producer: { subagentId: "k1" } },
      { kind: "background_call", id: "b1", tool: "Bash", status: "running", startedAt: "t", producer: { subagentId: "g" } },
      { kind: "background_call", id: "b2", tool: "Bash", status: "complete", startedAt: "t", producer: { subagentId: "k1" } },
      { kind: "subagent", id: "other", name: "other", status: "running" },
    ] as Entry[];
    const map = new Map(nested.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    assert.deepEqual(runningWork([...map.keys()], (key) => map.get(key)), [
      { kind: "agent", key: "subagent:r", name: "root", nested: { agents: 2, calls: 1 } },
      { kind: "agent", key: "subagent:other", name: "other", nested: { agents: 0, calls: 0 } },
    ]);
  });

  it("cards running work whose Subagents above it have all finished", () => {
    const orphaned: Entry[] = [
      { kind: "subagent", id: "p", name: "parent", status: "complete" },
      { kind: "subagent", id: "k", name: "child", status: "running", producer: { subagentId: "p" } },
      { kind: "subagent", id: "g", name: "grandchild", status: "running", producer: { subagentId: "k" } },
      { kind: "tool", id: "b", name: "Bash", input: { command: "npm test" }, status: "complete", producer: { subagentId: "p" } },
      { kind: "background_call", id: "b", tool: "Bash", status: "running", startedAt: "t", producer: { subagentId: "p" } },
    ] as Entry[];
    const map = new Map(orphaned.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    assert.deepEqual(runningWork([...map.keys()], (key) => map.get(key)), [
      { kind: "agent", key: "subagent:k", name: "child", nested: { agents: 1, calls: 0 } },
      { kind: "call", key: "tool:b", tool: "Bash", detail: "npm test", subagent: "subagent:p" },
    ]);
  });
});

describe("the nested work label", () => {
  it("names what is running below a Subagent", () => {
    assert.equal(nestedLabel({ agents: 2, calls: 1 }), "2 agents · 1 call running");
    assert.equal(nestedLabel({ agents: 1, calls: 0 }), "1 agent running");
    assert.equal(nestedLabel({ agents: 0, calls: 3 }), "3 calls running");
  });

  it("says nothing when nothing runs below it", () => {
    assert.equal(nestedLabel({ agents: 0, calls: 0 }), undefined);
  });
});
