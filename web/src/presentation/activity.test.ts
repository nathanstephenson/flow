import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activityLabel, activityStatusText, backgroundTiming } from "./activity.ts";

/**
 * The one sentence the rail's accessible text uses. Worth its own tests
 * because two surfaces read it: a wording change here moves both, which is the point.
 */
describe("what is working in an Agent Session", () => {
  it("says nothing when nothing is", () => {
    // Undefined rather than "", so a caller asks "is there a strip" rather than inspecting text.
    assert.equal(activityLabel({ activeSubagents: 0, activeBackgroundCalls: 0 }), undefined);
  });

  it("counts one without pluralising it", () => {
    assert.equal(activityLabel({ activeSubagents: 1, activeBackgroundCalls: 0 }), "1 agent running");
    assert.equal(activityLabel({ activeSubagents: 0, activeBackgroundCalls: 1 }), "1 background call running");
  });

  it("pluralises more than one", () => {
    assert.equal(activityLabel({ activeSubagents: 2, activeBackgroundCalls: 0 }), "2 agents running");
    assert.equal(activityLabel({ activeSubagents: 11, activeBackgroundCalls: 0 }), "11 agents running");
    assert.equal(activityLabel({ activeSubagents: 0, activeBackgroundCalls: 3 }), "3 background calls running");
  });

  it("joins independent work on one verb rather than saying `running` repeatedly", () => {
    assert.equal(
      activityLabel({ activeSubagents: 2, activeBackgroundCalls: 1, activeWorkflows: 1 }),
      "2 agents, 1 background call and 1 workflow running",
    );
  });

  it("names full workflow activity even when parent chat is otherwise idle", () => {
    assert.equal(
      activityLabel({ activeSubagents: 0, activeBackgroundCalls: 0, activeWorkflows: 1 }),
      "1 workflow running",
    );
  });

  it("leads with the agents, which are the half with somewhere to go", () => {
    // The strip is read left-to-right into its own chevron, so the clickable half comes first.
    const label = activityLabel({ activeSubagents: 1, activeBackgroundCalls: 1 });
    assert.ok(label?.startsWith("1 agent"), label);
  });

  it("floors each count separately, so one bad number cannot erase the other clause", () => {
    /*
     * Both counts are maintained by transitions and could underflow. Guarding them together — a
     * single "if either is negative, say nothing" — would let a Subagent bug hide a Background Call
     * that really is running, which is the thing this strip exists to report.
     */
    assert.equal(activityLabel({ activeSubagents: -1, activeBackgroundCalls: 2 }), "2 background calls running");
    assert.equal(activityLabel({ activeSubagents: 2, activeBackgroundCalls: -1 }), "2 agents running");
    assert.equal(activityLabel({ activeSubagents: -1, activeBackgroundCalls: 0 }), undefined);
  });
});

describe("the rail's spoken status", () => {
  it("is the status alone when nothing is working", () => {
    assert.equal(activityStatusText({ status: "idle", activeSubagents: 0, activeBackgroundCalls: 0 }), "idle");
  });

  it("leads with the status, which is what the dot's shape encodes", () => {
    assert.equal(
      activityStatusText({ status: "idle", activeSubagents: 0, activeBackgroundCalls: 1 }),
      "idle, 1 background call running",
    );
  });

  it("reuses the strip's exact wording rather than inventing a second one", () => {
    const of = { activeSubagents: 2, activeBackgroundCalls: 1 };
    assert.equal(activityStatusText({ ...of, status: "idle" }), `idle, ${activityLabel(of)}`);
  });
});

describe("how long a Background Call has been going", () => {
  const call = (over: Partial<{ status: "running" | "complete" | "aborted" | "error"; endedAt: string }>) =>
    ({
      kind: "background_call" as const,
      id: "c1",
      tool: "Bash",
      status: "running" as const,
      startedAt: "2026-01-01T00:00:00Z",
      ...over,
    });
  const now = Date.parse("2026-01-01T00:05:00Z");

  it("dates a running Call from when it started", () => {
    assert.equal(backgroundTiming(call({}), now).label, "started");
  });

  it("names what happened rather than saying `completed` for all three", () => {
    // A row where every finished Call reads the same would hide the two outcomes worth noticing.
    assert.equal(backgroundTiming(call({ status: "complete", endedAt: "2026-01-01T00:04:00Z" }), now).label, "finished");
    assert.equal(backgroundTiming(call({ status: "aborted", endedAt: "2026-01-01T00:04:00Z" }), now).label, "stopped");
    assert.equal(backgroundTiming(call({ status: "error", endedAt: "2026-01-01T00:04:00Z" }), now).label, "failed");
  });

  it("falls back to the start when a terminal snapshot carried no end", () => {
    const started = backgroundTiming(call({}), now).at;
    assert.equal(backgroundTiming(call({ status: "complete" }), now).at, started);
  });
});
