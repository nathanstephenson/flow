import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { moveSessionCursor, retainSessionCursor } from "./session-cursor.ts";

function session(id: string): SessionSummary {
  return {
    id,
    scope: "/tmp",
    backend: "fake",
    status: "idle",
    title: id,
    restingAt: "2026-01-01T00:00:00Z",
    activeSubagents: 0,
    activeBackgroundCalls: 0,
    activeWorkflows: 0,
    lastSeq: 0,
  };
}

describe("the Agent Session rail cursor", () => {
  it("retains identity when attention moves a row between groups", () => {
    const before = [session("a"), session("b"), session("c")];
    const after = [before[2]!, before[0]!, before[1]!];
    assert.equal(retainSessionCursor(before, after, "b"), "b");
  });

  it("chooses the neighbour only when the identity disappeared", () => {
    const before = [session("a"), session("b"), session("c")];
    assert.equal(retainSessionCursor(before, [session("a"), session("c")], "b"), "c");
    assert.equal(retainSessionCursor(before, [session("a"), session("b")], "c"), "b");
    assert.equal(retainSessionCursor([], [session("a")], undefined), "a");
    assert.equal(retainSessionCursor(before, [], "b"), undefined);
  });

  it("moves through selectable sessions only, independent of group headings", () => {
    const sessions = [session("needs"), session("unread"), session("idle")];
    assert.equal(moveSessionCursor(sessions, "needs", 1), "unread");
    assert.equal(moveSessionCursor(sessions, "idle", 1), "idle");
    assert.equal(moveSessionCursor(sessions, "needs", -1), "needs");
  });
});
