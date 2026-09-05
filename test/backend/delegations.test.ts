import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Delegations } from "../../src/backend/claude/delegations.ts";

/**
 * A `result` cannot be attributed to a Delegation — SDKResultMessage has no parent_tool_use_id — so
 * the turn end it reports is held until the last Delegation returns. Ending early clears
 * turnInFlight in the Session Host, and the Steering Queue then dispatches the next message into a
 * turn that is still running.
 */
describe("Delegations", () => {
  it("passes a turn end straight through when none is open", () => {
    const delegations = new Delegations();
    assert.equal(delegations.hold("complete"), false, "nothing to wait for, so the turn ends now");
  });

  it("holds the turn end until the Delegation returns", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore" });

    assert.equal(delegations.hold("complete"), true, "a result arriving mid-Delegation must not end the turn");
    assert.equal(delegations.returned("call_1"), "complete", "the held end is released by the last return");
  });

  it("ends once after the last of several Delegations", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore" });
    delegations.spawn("call_2", { name: "Explore" });
    delegations.hold("complete");

    assert.equal(delegations.returned("call_1"), undefined, "one of two returning must not end the turn");
    assert.equal(delegations.returned("call_2"), "complete");
  });

  it("does not invent a turn end for a Delegation nothing was waiting on", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore" });

    // The turn is still streaming: no result has arrived, so returning must release nothing.
    assert.equal(delegations.returned("call_1"), undefined);
  });

  it("ignores a tool result that is not a Delegation", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore" });
    delegations.hold("complete");

    assert.equal(delegations.returned("some_read"), undefined, "an ordinary tool must not release the turn");
    assert.equal(delegations.returned("call_1"), "complete");
  });

  it("forgets a held end once the turn has ended", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore" });
    delegations.hold("error");

    // endTurn clears, whatever the outcome — an unreturned Delegation must not end the *next* turn.
    delegations.clear();
    assert.equal(delegations.returned("call_1"), undefined);
    assert.equal(delegations.hold("complete"), false, "the next turn starts with nothing open");
  });
});

describe("what a Delegation was asked to do", () => {
  it("is remembered while it is open, so its closing snapshot can carry it", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore", description: "read package.json" });
    assert.deepEqual(delegations.describe("call_1"), { name: "Explore", description: "read package.json" });
  });

  it("is forgotten once it has returned", () => {
    const delegations = new Delegations();
    delegations.spawn("call_1", { name: "Explore" });
    delegations.returned("call_1");
    assert.equal(delegations.describe("call_1"), undefined);
  });

  it("says nothing about a tool call that is not a Delegation", () => {
    const delegations = new Delegations();
    assert.equal(delegations.describe("some_read"), undefined);
  });
})
