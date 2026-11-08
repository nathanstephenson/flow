import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { nextHeldAttention, parseOpenSections, parsePinnedSessions, railSection, visibleSessions, withHeldAttention } from "./rail-sections.ts";

function session(id: string, status: SessionSummary["status"], attention?: SessionSummary["attention"]): SessionSummary {
  return {
    id,
    scope: "/tmp",
    backend: "fake",
    status,
    title: id,
    restingAt: "2026-01-01T00:00:00Z",
    activeSubagents: 0,
    activeBackgroundCalls: 0,
    activeWorkflows: 0,
    lastSeq: 0,
    ...(attention ? { attention } : {}),
  };
}

describe("the Agent Session rail sections", () => {
  const unread = session("unread", "idle", { group: "unread", reason: "Completed", at: "2026-01-01T00:00:00Z", version: 1, observedSeq: 0 });
  const running = session("running", "running");
  const idle = session("idle", "idle");
  const dormant = session("dormant", "dormant");
  const settled = session("settled", "settled");
  const all = [unread, running, idle, dormant, settled];

  it("puts Idle and Dormant in one section", () => {
    assert.equal(railSection(idle), "idle");
    assert.equal(railSection(dormant), "idle");
  });

  it("shows only attention rows while every section is collapsed", () => {
    assert.deepEqual(visibleSessions(all, new Set(), new Set()).map(({ id }) => id), ["unread"]);
  });

  it("shows the rows of open sections", () => {
    assert.deepEqual(visibleSessions(all, new Set(["idle"]), new Set()).map(({ id }) => id), ["unread", "idle", "dormant"]);
    assert.deepEqual(
      visibleSessions(all, new Set(["working", "idle", "filed-away"]), new Set()).map(({ id }) => id),
      ["unread", "running", "idle", "dormant", "settled"],
    );
  });

  it("reads only known collapsible sections from storage", () => {
    assert.deepEqual([...parseOpenSections('["working","unread","bogus","idle"]')], ["working", "idle"]);
    assert.deepEqual([...parseOpenSections("not json")], []);
    assert.deepEqual([...parseOpenSections(null)], []);
  });

  it("keeps an open session Unread after it is read, until the user opens another", () => {
    const read = session("unread", "idle");
    const held = nextHeldAttention(undefined, all, "unread");
    assert.equal(nextHeldAttention(held, [read, running], "unread"), held);
    assert.equal(railSection(withHeldAttention([read, running], held)[0]!), "unread");
    assert.equal(nextHeldAttention(held, [read, running], "running"), undefined);
  });

  it("does not hold a session that was not Unread, or replace newer attention", () => {
    assert.equal(nextHeldAttention(undefined, all, "idle"), undefined);
    const held = nextHeldAttention(undefined, all, "unread");
    const asking = session("unread", "awaiting", { group: "needs-input", reason: "Input needed", at: "2026-01-01T00:00:00Z", version: 2, observedSeq: 0 });
    assert.equal(railSection(withHeldAttention([asking], held)[0]!), "needs-input");
  });

  it("shows pinned sessions below Unread, in that order for the cursor", () => {
    const pinned = new Set(["dormant", "running", "settled"]);
    assert.equal(railSection(dormant, pinned), "pinned");
    assert.equal(railSection(unread, new Set(["unread"])), "unread");
    assert.equal(railSection(settled, pinned), "filed-away");
    assert.deepEqual(visibleSessions(all, new Set(["idle"]), pinned).map(({ id }) => id), ["unread", "running", "dormant", "idle"]);
  });

  it("reads only session ids as pins from storage", () => {
    assert.deepEqual([...parsePinnedSessions('["a",1,"b"]')], ["a", "b"]);
    assert.deepEqual([...parsePinnedSessions("not json")], []);
  });
});
