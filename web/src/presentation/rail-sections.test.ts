import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { parseOpenSection, railSection, visibleSessions } from "./rail-sections.ts";

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
    assert.deepEqual(visibleSessions(all, undefined).map(({ id }) => id), ["unread"]);
  });

  it("shows the rows of open sections", () => {
    assert.deepEqual(visibleSessions(all, "idle").map(({ id }) => id), ["unread", "idle", "dormant"]);
  });

  it("reads only a known collapsible section from storage", () => {
    assert.equal(parseOpenSection("working"), "working");
    assert.equal(parseOpenSection("unread"), undefined);
    assert.equal(parseOpenSection("bogus"), undefined);
    assert.equal(parseOpenSection(null), undefined);
  });
});
