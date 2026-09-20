import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canRevive, canSettle, deriveStatus, occupied, railGroup, working } from "../src/client/status.ts";
import type { SessionLifecycle, SessionStatus } from "../src/protocol/commands.ts";

/**
 * The rules the Session Host and both front-ends share. Worth their own tests because they are the
 * one place the derivation lives: the host reports these values and the reducer reproduces them, so
 * a change here moves the rail and the pane together or breaks both.
 */
describe("what a status means", () => {
  const LIFECYCLES: SessionLifecycle[] = ["live", "dormant", "settled", "ended"];

  it("reports the Lifecycle unchanged wherever it is not live", () => {
    for (const lifecycle of LIFECYCLES.filter((value) => value !== "live")) {
      for (const turnInFlight of [false, true]) {
        for (const awaiting of [false, true]) {
          assert.equal(
            deriveStatus({ lifecycle, turnInFlight, awaiting }),
            lifecycle,
            `${lifecycle} must survive turnInFlight=${turnInFlight} awaiting=${awaiting}`,
          );
        }
      }
    }
  });

  it("derives the three activities of a live Agent Session", () => {
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: false, awaiting: false }), "idle");
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: true, awaiting: false }), "running");
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: true, awaiting: true }), "awaiting");
  });

  it("prefers awaiting over running, because that is the one that needs a person", () => {
    // Both are true of a turn blocked on a Permission Prompt. The rail has one dot, and the useful
    // thing to say is that it is stuck rather than that it is busy.
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: true, awaiting: true }), "awaiting");
    // And a prompt outliving `turnInFlight` still reads as awaiting rather than idle.
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: false, awaiting: true }), "awaiting");
  });

  it("counts awaiting as occupied, so nothing offered mid-turn is offered then", () => {
    const occupying: SessionStatus[] = ["running", "awaiting"];
    const free: SessionStatus[] = ["idle", "dormant", "settled", "ended"];
    for (const status of occupying) assert.equal(occupied(status), true, status);
    for (const status of free) assert.equal(occupied(status), false, status);
  });

  it("treats awaiting as a live Agent Session for Settle and Revive", () => {
    // Awaiting means a Backend Session is attached, so there is nothing to Revive — and filing it
    // away is still allowed, which is how someone escapes a prompt they do not want to answer.
    assert.equal(canSettle("awaiting"), true);
    assert.equal(canRevive("awaiting"), false);
  });

  describe("attention groups", () => {
    const summary = {
      status: "idle" as const,
      activeSubagents: 0,
      activeBackgroundCalls: 0,
      activeWorkflows: 0,
    };

    it("puts Needs input and Unread above activity without redefining it", () => {
      assert.equal(railGroup({ ...summary, attention: { group: "needs-input", reason: "Input needed", at: "", version: 1, observedSeq: 1 } }), "needs-input");
      assert.equal(railGroup({ ...summary, attention: { group: "unread", reason: "Completed", at: "", version: 1, observedSeq: 1 } }), "unread");
      assert.equal(railGroup(summary), "idle");
      assert.equal(summary.status, "idle", "attention must not fabricate parent occupancy");
    });

    it("files both terminal lifecycle states away, even with a stale request index", () => {
      const stale = { group: "needs-input" as const, reason: "Input needed" as const, at: "", version: 1, observedSeq: 1 };
      assert.equal(railGroup({ ...summary, status: "settled", attention: stale }), "filed-away");
      assert.equal(railGroup({ ...summary, status: "ended", attention: stale }), "filed-away");
    });
  });

  describe("working", () => {
    it("is an Idle Agent Session with a Subagent still going", () => {
      assert.equal(working({ status: "idle", activeSubagents: 1, activeBackgroundCalls: 0 }), true);
      assert.equal(working({ status: "idle", activeSubagents: 0, activeBackgroundCalls: 0 }), false);
    });

    it("is not a status a running or non-live Agent Session can wear", () => {
      // Running already says it, and a count on anything not live is a stale index.
      assert.equal(working({ status: "running", activeSubagents: 1, activeBackgroundCalls: 0 }), false);
      assert.equal(working({ status: "dormant", activeSubagents: 1, activeBackgroundCalls: 0 }), false);
      assert.equal(working({ status: "settled", activeSubagents: 1, activeBackgroundCalls: 0 }), false);
    });

    it("is true for either kind of background work, and for both at once", () => {
      // The one question that does not care which of them is busy, which is why the two counts are
      // summed here and nowhere else.
      assert.equal(working({ status: "idle", activeSubagents: 0, activeBackgroundCalls: 1 }), true);
      assert.equal(working({ status: "idle", activeSubagents: 1, activeBackgroundCalls: 1 }), true);
      assert.equal(working({ status: "idle", activeSubagents: 0, activeBackgroundCalls: 0 }), false);
    });

    it("is true for a full workflow without fabricating parent occupancy", () => {
      assert.equal(working({ status: "idle", activeSubagents: 0, activeBackgroundCalls: 0, activeWorkflows: 1 }), true);
      assert.equal(working({ status: "running", activeSubagents: 0, activeBackgroundCalls: 0, activeWorkflows: 1 }), false);
    });

    it("is not a status a Background Call can give a non-live Agent Session", () => {
      assert.equal(working({ status: "running", activeSubagents: 0, activeBackgroundCalls: 1 }), false);
      assert.equal(working({ status: "dormant", activeSubagents: 0, activeBackgroundCalls: 1 }), false);
    });
  });
});
