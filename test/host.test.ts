import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import type { AgentEvent } from "../src/protocol/events.ts";

function events(host: SessionHost, id: string): AgentEvent[] {
  return host.logFor(id).since(0).map((entry) => entry.event);
}

function typesOf(host: SessionHost, id: string): string[] {
  return events(host, id).map((event) => event.type);
}

describe("SessionHost", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
  });

  it("records session_started with the backend's capabilities", () => {
    const [first] = events(host, sessionId);
    assert.equal(first?.type, "session_started");
    assert.deepEqual(first?.type === "session_started" ? first.capabilities.providers : [], ["fake"]);
  });

  it("dispatches a 'now' send immediately and records what the human sent", async () => {
    await host.send(sessionId, "hello", "now");
    assert.deepEqual(backend.latest.prompts, ["hello"]);
    // model_changed: an adapter announces the model in force as soon as the session opens, which
    // is what tells a client which Effort levels it may offer.
    assert.deepEqual(typesOf(host, sessionId), [
      "session_started",
      "model_changed",
      "user_message",
      "turn_started",
    ]);
  });

  it("keeps the chosen Effort across a Revive", async () => {
    await host.setEffort(sessionId, "high");
    assert.equal(backend.latest.effort, "high");

    await host.shutdown();
    await host.revive(sessionId);

    assert.equal(backend.sessions.length, 2, "revive must start a fresh Backend Session");
    assert.equal(backend.latest.effort, "high", "a revived session must not silently drop the choice");
  });

  it("revives once when two sends race into a Dormant Agent Session", async () => {
    await host.shutdown();
    assert.equal(backend.sessions.length, 1, "precondition: one Backend Session so far");

    await Promise.all([
      host.send(sessionId, "first", "after_turn"),
      host.send(sessionId, "second", "after_turn"),
    ]);

    // Two backends for one Agent Session leaves the loser orphaned but still emitting into this
    // transcript, and splits the two messages across two Backend Sessions.
    assert.equal(backend.sessions.length, 2, "a raced revive must not start a second Backend Session");
    assert.equal(
      events(host, sessionId).filter((event) => event.type === "revived").length,
      1,
      "a raced revive must record one Revive, not two",
    );
    assert.deepEqual(backend.latest.prompts, ["first"], "both sends must reach the surviving backend");
  });

  it("holds an 'after_turn' send until the turn ends, then dispatches it", async () => {
    await host.send(sessionId, "first", "now");
    await host.send(sessionId, "second", "after_turn");

    assert.deepEqual(backend.latest.prompts, ["first"], "queued message must not reach the backend");
    const queued = events(host, sessionId).find((event) => event.type === "queue_changed");
    assert.deepEqual(queued?.type === "queue_changed" ? queued.pending : [], ["second"]);

    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(backend.latest.prompts, ["first", "second"]);
    const pendings = events(host, sessionId)
      .filter((event) => event.type === "queue_changed")
      .map((event) => (event.type === "queue_changed" ? event.pending : []));
    assert.deepEqual(pendings, [["second"], []]);
  });

  it("queues in FIFO order and releases one message per turn", async () => {
    await host.send(sessionId, "first", "now");
    await host.send(sessionId, "second", "after_turn");
    await host.send(sessionId, "third", "after_turn");

    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(backend.latest.prompts, ["first", "second"]);

    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(backend.latest.prompts, ["first", "second", "third"]);
  });

  it("queues even before the backend acknowledges the turn", async () => {
    // The host marks a turn in flight when it dispatches, not when the backend reports
    // turn_started. Without that, this send would jump the queue.
    const dispatching = host.send(sessionId, "first", "now");
    await host.send(sessionId, "second", "after_turn");
    await dispatching;

    assert.deepEqual(backend.latest.prompts, ["first"]);
  });

  it("drops queued messages when the turn is aborted", async () => {
    await host.send(sessionId, "first", "now");
    await host.send(sessionId, "second", "after_turn");

    await host.abort(sessionId);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(backend.latest.prompts, ["first"], "abort means stop, not stop-then-continue");
    const last = events(host, sessionId).filter((event) => event.type === "queue_changed").at(-1);
    assert.deepEqual(last?.type === "queue_changed" ? last.pending : ["unset"], []);
  });

  it("a 'now' send steers mid-turn instead of queueing", async () => {
    await host.send(sessionId, "first", "now");
    await host.send(sessionId, "steer", "now");
    assert.deepEqual(backend.latest.prompts, ["first", "steer"]);
  });

  it("dispatches an after_turn send straight away after a Revive", async () => {
    // ADR 0003's one-action Revive: the message that revives must run, not sit in the Steering Queue
    // with no turn left to release it. Going Dormant resets turnInFlight and revive() leaves it
    // alone, which is what makes always sending after_turn safe on this path.
    await host.send(sessionId, "first", "after_turn");
    await host.shutdown();
    await host.revive(sessionId);
    await host.send(sessionId, "carry on", "after_turn");

    assert.deepEqual(backend.latest.prompts, ["carry on"]);
    assert.equal(host.statusOf(sessionId), "running");
  });

  it("disposes the Backend Session and closes the transcript", async () => {
    const session = backend.latest;
    await host.dispose(sessionId);
    assert.equal(session.disposed, true);
    assert.equal(typesOf(host, sessionId).at(-1), "session_ended");
  });

  it("ignores backend events arriving after disposal", async () => {
    const session = backend.latest;
    await host.send(sessionId, "hello", "now");
    await host.dispose(sessionId);
    const before = typesOf(host, sessionId).length;
    session.say("late");
    assert.equal(typesOf(host, sessionId).length, before);
  });
});

/**
 * A Subagent cannot outlive the turn that spawned it (ADR 0015). One still running when the turn
 * is gone renders on a Revive as a subagent working forever, with a spinner nothing will stop — so
 * the Session Host closes it wherever it closes a torn turn.
 */
describe("a Subagent the turn left behind", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  const subagentStates = (): string[] =>
    events(host, sessionId)
      .filter((event) => event.type === "subagent")
      .map((event) => (event.type === "subagent" ? event.state : ""));

  beforeEach(async () => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.send(sessionId, "go", "now");
  });

  it("is aborted when the Agent Session Settles", async () => {
    backend.latest.beginSubagent("explorer");
    await host.settle(sessionId);

    assert.deepEqual(subagentStates(), ["running", "aborted"]);
    // Before session_settled, the same ordering rule the synthetic turn_ended follows: a state
    // arriving after the Settle would reduce the pane back out of it.
    const types = typesOf(host, sessionId);
    assert.ok(types.lastIndexOf("subagent") < types.indexOf("session_settled"));
  });

  it("is aborted when the host shuts down", async () => {
    backend.latest.beginSubagent("explorer");
    await host.shutdown();

    assert.deepEqual(subagentStates(), ["running", "aborted"]);
    const types = typesOf(host, sessionId);
    assert.ok(types.lastIndexOf("subagent") < types.indexOf("session_dormant"));
  });

  it("leaves a Subagent that finished on its own alone", async () => {
    const subagent = backend.latest.beginSubagent("explorer");
    subagent.finish("complete");
    await host.shutdown();

    assert.deepEqual(subagentStates(), ["running", "complete"], "no second terminal state");
  });

  it("closes each of several open Subagents", async () => {
    backend.latest.beginSubagent("one");
    const two = backend.latest.beginSubagent("two");
    backend.latest.beginSubagent("three");
    two.finish("complete");
    await host.shutdown();

    const aborted = events(host, sessionId).filter(
      (event) => event.type === "subagent" && event.state === "aborted",
    );
    assert.equal(aborted.length, 2, "the one that finished must not be closed again");
  });

  it("closes a Subagent that was waiting, not only one that was running", async () => {
    backend.latest.beginSubagent("explorer").wait("permission");
    await host.shutdown();

    assert.deepEqual(subagentStates(), ["running", "waiting", "aborted"]);
  });
});

/**
 * Compaction, and the three states the host refuses it in.
 *
 * Each refusal is a case where compacting would be a lie rather than a failure, so each is asserted
 * on its own — and on the transcript staying untouched, because a refused command must leave no
 * bytes behind in an append-only record.
 */
describe("compacting a Conversation Context", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    backend = new FakeBackend({ compaction: true });
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
  });

  it("asks the backend, and carries instructions when there are any", async () => {
    await host.compact(sessionId);
    await host.compact(sessionId, "keep the API decisions");

    assert.deepEqual(backend.latest.compactions, [undefined, "keep the API decisions"]);
  });

  // No `user_message`: compaction is not something anyone said, and ADR 0001 puts the act itself in
  // the backend. The turn around it is the backend's own work being declared, not a record of the
  // request — and it is what makes the session occupied while it runs.
  it("opens a turn and writes no message of its own", async () => {
    const before = typesOf(host, sessionId).length;
    await host.compact(sessionId);

    assert.deepEqual(typesOf(host, sessionId).slice(before), ["turn_started", "compacted", "turn_ended"]);
  });

  /*
   * The bug this test exists for.
   *
   * A compaction spends money and holds the backend for minutes, and it used to say so to nobody:
   * `turnInFlight` stayed false, so a message typed during one was dispatched straight into the
   * backend ahead of it instead of queueing, and a second `/compact` sailed past the refusal below.
   * Both are the same missing fact.
   */
  it("occupies the session while it runs, so a message queues behind it", async () => {
    backend.latest.holdCompaction = true;
    await host.compact(sessionId);

    await host.send(sessionId, "hello", "after_turn");

    assert.deepEqual(backend.latest.prompts, [], "the message waited rather than jumping the queue");
    assert.ok(typesOf(host, sessionId).includes("queue_changed"), "it is in the Steering Queue");
  });

  it("refuses a second compaction while the first is still running", async () => {
    backend.latest.holdCompaction = true;
    await host.compact(sessionId);

    await assert.rejects(() => host.compact(sessionId), /running/);
    assert.deepEqual(backend.latest.compactions, [undefined], "only the first was asked for");
  });

  it("refuses while a turn is in flight, rather than queueing behind it", async () => {
    await host.send(sessionId, "hello", "now");
    const before = typesOf(host, sessionId).length;

    await assert.rejects(() => host.compact(sessionId), /running/);
    assert.equal(typesOf(host, sessionId).length, before, "a refusal leaves no bytes behind");
    assert.deepEqual(backend.latest.compactions, []);
  });

  /*
   * A Revive restores the conversation from its resume token rather than summarising it, so what
   * gets compacted here is the real thing — and a session parked at 90% occupancy is the one most
   * worth compacting before it is picked up again. Same rule as `send` (ADR 0003).
   */
  it("Revives a Dormant session rather than refusing it", async () => {
    await host.shutdown();
    assert.equal(host.list().find((session) => session.id === sessionId)?.status, "dormant");

    await host.compact(sessionId);

    assert.deepEqual(backend.latest.compactions, [undefined]);
    assert.equal(host.list().find((session) => session.id === sessionId)?.status, "idle");
    assert.ok(typesOf(host, sessionId).includes("revived"), "the Revive is on the record");
  });

  // The one state with no Conversation Context to reach, and a refusal rather than a 500.
  it("refuses an Ended session", async () => {
    await host.dispose(sessionId);

    await assert.rejects(() => host.compact(sessionId), /has Ended/);
  });

  it("refuses a backend that does not declare compaction", async () => {
    const plain = new FakeBackend();
    const other = new SessionHost();
    other.registerBackend(plain);
    const id = await other.create({ scope: "/tmp/scope", backend: "fake" });

    await assert.rejects(() => other.compact(id), /cannot compact/);
    assert.deepEqual(plain.latest.compactions, [], "the method exists; the flag is what gates it");
  });
});

/**
 * The Skill catalogue.
 *
 * Every case that cannot be answered properly answers with an empty list, which is the opposite of
 * how `compact` behaves and deliberately so: a refusal is right for an act with consequences and
 * wrong for a menu somebody opened with a keystroke.
 */
describe("listing the Skills an Agent Session offers", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
  });

  it("answers with what the backend reports, argument hints and all", async () => {
    assert.deepEqual(await host.listSkills(sessionId), [
      { name: "tdd", description: "Red, green, refactor" },
      { name: "review", description: "Review the diff", argumentHint: "[<pr#>|<branch>]" },
    ]);
  });

  // Opening a menu is not a reason to start a Backend Session and spend money (ADR 0003).
  it("answers empty for a Dormant session rather than Reviving it", async () => {
    await host.shutdown();

    assert.deepEqual(await host.listSkills(sessionId), []);
    assert.equal(host.list().find((session) => session.id === sessionId)?.status, "dormant");
  });

  it("answers empty when the backend cannot read its own Skills", async () => {
    backend.latest.skills = async () => {
      throw new Error("skills directory is unreadable");
    };

    assert.deepEqual(await host.listSkills(sessionId), []);
  });

  it("writes nothing down, so a menu is not activity on the transcript", async () => {
    const before = typesOf(host, sessionId).length;
    await host.listSkills(sessionId);

    assert.equal(typesOf(host, sessionId).length, before);
  });
});
