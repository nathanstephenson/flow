import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { parseOpenSections, railSection, visibleSessions } from "./rail-sections.ts";

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
    assert.deepEqual(visibleSessions(all, new Set()).map(({ id }) => id), ["unread"]);
  });

  it("shows the rows of open sections", () => {
    assert.deepEqual(visibleSessions(all, new Set(["idle"])).map(({ id }) => id), ["unread", "idle", "dormant"]);
    assert.deepEqual(
      visibleSessions(all, new Set(["working", "idle", "filed-away"])).map(({ id }) => id),
      ["unread", "running", "idle", "dormant", "settled"],
    );
  });

  it("reads only known collapsible sections from storage", () => {
    assert.deepEqual([...parseOpenSections('["working","unread","bogus","idle"]')], ["working", "idle"]);
    assert.deepEqual([...parseOpenSections("not json")], []);
    assert.deepEqual([...parseOpenSections(null)], []);
  });
});
