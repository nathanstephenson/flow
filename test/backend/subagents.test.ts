import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Subagents } from "../../src/backend/claude/subagents.ts";

/**
 * A `result` cannot be attributed to a Subagent — SDKResultMessage has no parent_tool_use_id — so
 * the turn end it reports is held until the last Subagent returns. Ending early clears
 * turnInFlight in the Session Host, and the Steering Queue then dispatches the next message into a
 * turn that is still running.
 */
describe("Subagents", () => {
  it("passes a turn end straight through when none is open", () => {
    const subagents = new Subagents();
    assert.equal(subagents.hold("complete"), false, "nothing to wait for, so the turn ends now");
  });

  it("holds the turn end until the Subagent returns", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore" });

    assert.equal(subagents.hold("complete"), true, "a result arriving mid-Subagent must not end the turn");
    assert.equal(subagents.returned("call_1"), "complete", "the held end is released by the last return");
  });

  it("ends once after the last of several Subagents", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore" });
    subagents.spawn("call_2", { name: "Explore" });
    subagents.hold("complete");

    assert.equal(subagents.returned("call_1"), undefined, "one of two returning must not end the turn");
    assert.equal(subagents.returned("call_2"), "complete");
  });

  it("does not invent a turn end for a Subagent nothing was waiting on", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore" });

    // The turn is still streaming: no result has arrived, so returning must release nothing.
    assert.equal(subagents.returned("call_1"), undefined);
  });

  it("ignores a tool result that is not a Subagent", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore" });
    subagents.hold("complete");

    assert.equal(subagents.returned("some_read"), undefined, "an ordinary tool must not release the turn");
    assert.equal(subagents.returned("call_1"), "complete");
  });

  it("forgets a held end once the turn has ended", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore" });
    subagents.hold("error");

    // endTurn clears, whatever the outcome — an unreturned Subagent must not end the *next* turn.
    subagents.clear();
    assert.equal(subagents.returned("call_1"), undefined);
    assert.equal(subagents.hold("complete"), false, "the next turn starts with nothing open");
  });
});

describe("what a Subagent was asked to do", () => {
  it("is remembered while it is open, so its closing snapshot can carry it", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore", description: "read package.json" });
    assert.deepEqual(subagents.describe("call_1"), { name: "Explore", description: "read package.json" });
  });

  it("is forgotten once it has returned", () => {
    const subagents = new Subagents();
    subagents.spawn("call_1", { name: "Explore" });
    subagents.returned("call_1");
    assert.equal(subagents.describe("call_1"), undefined);
  });

  it("says nothing about a tool call that is not a Subagent", () => {
    const subagents = new Subagents();
    assert.equal(subagents.describe("some_read"), undefined);
  });
})
