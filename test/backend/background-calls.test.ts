import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BackgroundCalls } from "../../src/backend/claude/background-calls.ts";
import { Subagents } from "../../src/backend/claude/subagents.ts";

/**
 * The bookkeeping a Background Call needs, which is not the bookkeeping a Subagent needs: no held
 * turn end, and a name that has to be remembered from the `tool_use` block because every later
 * message about the call carries ids and nothing else (ADR 0021).
 *
 * The message order these assertions encode was captured, not assumed — see
 * `spikes/background-call-messages.ts`.
 */
describe("BackgroundCalls", () => {
  it("names a Call from the tool call that was announced", () => {
    const calls = new BackgroundCalls();
    calls.called("call-1", { tool: "Bash" });
    assert.deepEqual(calls.launch("call-1"), { tool: "Bash" });
    assert.deepEqual(calls.describe("call-1"), { tool: "Bash" });
  });

  it("refuses to launch a call it never saw announced", () => {
    // The alternative is a card named after a guess, which is worse than no card: the name is only
    // ever knowable from the `tool_use` block.
    const calls = new BackgroundCalls();
    assert.equal(calls.launch("never-seen"), undefined);
    assert.equal(calls.describe("never-seen"), undefined);
  });

  it("launches a call once, however often the CLI says so", () => {
    // Guards the count as much as the transcript: a second launch snapshot would count twice.
    const calls = new BackgroundCalls();
    calls.called("call-1", { tool: "Monitor" });
    assert.notEqual(calls.launch("call-1"), undefined);
    assert.equal(calls.launch("call-1"), undefined, "already open, so there is nothing new to say");
  });

  it("carries the producer, so every snapshot agrees about it", () => {
    // A Subagent can background a Bash. The web client decides from `producer` which surface the
    // card belongs to, so a terminal snapshot that dropped it would move the card as it settled.
    const calls = new BackgroundCalls();
    const producer = { subagentId: "agent-7" };
    calls.called("call-1", { tool: "Bash", producer });
    calls.launch("call-1");
    assert.deepEqual(calls.settled("call-1"), { tool: "Bash", producer });
  });

  it("maps a task id for a call it has only seen announced", () => {
    // `task_started` arrives *before* the launching `tool_result` — captured at 9.2s against 9.3s —
    // so at the moment it is noted the call is `pending` and not yet open.
    const calls = new BackgroundCalls();
    calls.called("call-1", { tool: "Bash" });
    calls.noteTask("task-1", "call-1");
    assert.equal(calls.callIdOf("task-1"), "call-1");
  });

  it("refuses a task id for a call it has never heard of", () => {
    const calls = new BackgroundCalls();
    calls.noteTask("task-1", "call-1");
    assert.equal(calls.callIdOf("task-1"), undefined);
  });

  it("settles once, though a Call settles through two messages", () => {
    // `task_updated` and `task_notification` both arrive in the same tick with the same outcome, and
    // a caller emitting a terminal snapshot for each would write two.
    const calls = new BackgroundCalls();
    calls.called("call-1", { tool: "Bash" });
    calls.launch("call-1");
    assert.deepEqual(calls.settled("call-1"), { tool: "Bash" });
    assert.equal(calls.settled("call-1"), undefined, "the second message must say nothing");
  });

  it("forgets a settled Call's task ids, so a later task id cannot reach it", () => {
    const calls = new BackgroundCalls();
    calls.called("call-1", { tool: "Bash" });
    calls.launch("call-1");
    calls.noteTask("task-1", "call-1");
    calls.settled("call-1");
    assert.equal(calls.callIdOf("task-1"), undefined);
  });

  it("keeps open Calls across a turn end and drops the calls that turn announced", () => {
    // The whole of ADR 0021: one outlives the turn that made it, and the snapshot closing it is
    // emitted turns later from the brief kept here.
    const calls = new BackgroundCalls();
    calls.called("open", { tool: "Bash" });
    calls.launch("open");
    calls.called("foreground", { tool: "Read" });

    calls.clear();

    assert.deepEqual(calls.describe("open"), { tool: "Bash" }, "an open Call survives its turn");
    assert.equal(calls.launch("foreground"), undefined, "a call the turn merely announced does not");
  });

  it("drops everything for a Backend Session being taken away", () => {
    // Background Calls are children of the CLI process and go when it goes.
    const calls = new BackgroundCalls();
    calls.called("call-1", { tool: "Bash" });
    calls.launch("call-1");
    calls.noteTask("task-1", "call-1");

    calls.abandon();

    assert.equal(calls.describe("call-1"), undefined);
    assert.equal(calls.callIdOf("task-1"), undefined);
  });

  it("shares no task id space with Subagent bookkeeping", () => {
    /*
     * The property ADR 0016 built and this feature had to preserve. `Subagents.noteTask` refuses a
     * callId it does not know as a Subagent's, and this class refuses one it has not been told
     * about — so a task id lands in exactly one of them, and a `task_updated` carrying nothing but
     * a task id can only be routed one way.
     */
    const subagents = new Subagents();
    const calls = new BackgroundCalls();

    subagents.spawn("agent-call", { name: "Explore" });
    calls.called("bash-call", { tool: "Bash" });
    calls.launch("bash-call");

    subagents.noteTask("agent-task", "agent-call");
    calls.noteTask("bash-task", "bash-call");

    assert.equal(calls.callIdOf("agent-task"), undefined, "a Subagent's task is not a Call's");
    assert.equal(subagents.callIdOf("bash-task"), undefined, "and a Call's is not a Subagent's");

    // And neither will adopt the other's callId if offered it.
    subagents.noteTask("crossed", "bash-call");
    calls.noteTask("crossed", "agent-call");
    assert.equal(subagents.callIdOf("crossed"), undefined);
    assert.equal(calls.callIdOf("crossed"), undefined);
  });
});
