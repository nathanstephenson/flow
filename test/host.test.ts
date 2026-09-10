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
 * A backgrounded Subagent outlives its turn (ADR 0016), so the Steering Queue must not treat it as
 * occupancy: the parent model has stopped and is waiting to be woken, and a session that refuses to
 * dispatch through that window is idle while claiming to be busy.
 */
describe("steering past a backgrounded Subagent", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.send(sessionId, "one", "now");
  });

  it("dispatches the next message while the Subagent is still running", async () => {
    const subagent = backend.latest.beginSubagent("explorer");
    subagent.launch();
    backend.latest.completeTurn();

    await host.send(sessionId, "two", "after_turn");

    assert.deepEqual(backend.latest.prompts, ["one", "two"], "the launch must not hold the queue");
    assert.deepEqual(
      events(host, sessionId).filter((event) => event.type === "queue_changed"),
      [],
      "nothing was ever queued, so nothing was ever pending",
    );
  });

  it("still closes the Subagent when it reports, turns later", async () => {
    const subagent = backend.latest.beginSubagent("explorer");
    subagent.launch();
    backend.latest.completeTurn();
    await host.send(sessionId, "two", "after_turn");
    subagent.finish("complete");

    const states = events(host, sessionId)
      .filter((event) => event.type === "subagent")
      .map((event) => (event.type === "subagent" ? event.state : ""));
    assert.deepEqual(states, ["running", "complete"]);
  });

  it("occupies the session again for a turn the backend opened on its own", async () => {
    backend.latest.beginSubagent("explorer").launch();
    backend.latest.completeTurn();

    // What the Claude adapter mints when a settled Subagent wakes the model: a turn nobody asked
    // for. The host has to see it as occupancy or the next send jumps into it.
    backend.latest.startTurn();
    await host.send(sessionId, "two", "after_turn");

    assert.deepEqual(backend.latest.prompts, ["one"], "the minted turn must hold the queue");
    assert.equal(host.statusOf(sessionId), "running");
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

/**
 * The same question for a Scope with no Agent Session in it — what the New Agent Session view asks.
 *
 * The pair above it is the point of comparison: that one is free, because the Backend Session is
 * already running. This one has to open one, which is why it alone dedupes concurrent askers — and
 * why it deliberately holds nothing once they have been answered. A Skill directory changes when
 * somebody saves a file, so an answer kept is an answer that has stopped being true; the spawn is
 * made affordable by the client asking early, not by the host remembering.
 */
describe("listing the Skills a Scope offers", () => {
  let backend: FakeBackend;
  let host: SessionHost;

  beforeEach(() => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
  });

  it("answers from a throwaway session that runs no tools and is disposed of", async () => {
    assert.deepEqual(await host.skillsFor("/tmp/scope", "fake"), {
      backend: "fake",
      scope: "/tmp/scope",
      skills: [
        { name: "tdd", description: "Red, green, refactor" },
        { name: "review", description: "Review the diff", argumentHint: "[<pr#>|<branch>]" },
      ],
    });

    assert.equal(backend.sessions.length, 1);
    assert.equal(backend.sessions[0]?.toolless, true, "a probe runs no tools (ADR 0020)");
    assert.equal(backend.sessions[0]?.disposed, true);
    assert.deepEqual(host.list(), [], "a probe must not become an Agent Session");
  });

  it("spawns one backend for two callers asking at once", async () => {
    backend.holdCreate = true;
    const both = Promise.all([
      host.skillsFor("/tmp/scope", "fake"),
      host.skillsFor("/tmp/scope", "fake"),
    ]);
    backend.releaseCreate();
    const [left, right] = await both;

    assert.equal(backend.sessions.length, 1, "the second caller joined the first one's probe");
    assert.deepEqual(left, right);
  });

  /*
   * The deliberate absence of a cache, and the one behaviour a reader would otherwise assume away
   * given `models` directly above it holds its probes for the daemon's life.
   */
  it("asks again once the first answer has settled", async () => {
    await host.skillsFor("/tmp/scope", "fake");
    await host.skillsFor("/tmp/scope", "fake");

    assert.equal(backend.sessions.length, 2);
  });

  /*
   * Concurrent, deliberately: sequential asks re-probe anyway, so only an overlapping pair can tell
   * a key that includes the Scope from one that does not. Without the Scope in the key, the second
   * caller here would be handed the first Scope's Skills.
   */
  it("does not let two Scopes asking at once share one probe", async () => {
    backend.holdCreate = true;
    const both = Promise.all([
      host.skillsFor("/tmp/one", "fake"),
      host.skillsFor("/tmp/two", "fake"),
    ]);
    backend.releaseCreate();
    const [left, right] = await both;

    assert.equal(backend.sessions.length, 2);
    assert.equal(left?.scope, "/tmp/one");
    assert.equal(right?.scope, "/tmp/two");
  });

  it("reports a problem rather than an empty catalogue when the backend cannot start", async () => {
    host.registerBackend({
      name: "broken",
      create: async () => {
        throw new Error("not logged in");
      },
    });

    assert.deepEqual(await host.skillsFor("/tmp/scope", "broken"), {
      backend: "broken",
      scope: "/tmp/scope",
      skills: [],
      problem: "not logged in",
    });
  });

  // Holding a failure would tell somebody who has just logged their CLI in that it is still broken.
  it("holds no failure, so a backend that starts working answers on the next ask", async () => {
    let attempts = 0;
    host.registerBackend({
      name: "flaky",
      create: async (options) => {
        attempts += 1;
        if (attempts === 1) throw new Error("not logged in");
        return await backend.create(options);
      },
    });

    assert.equal((await host.skillsFor("/tmp/scope", "flaky")).problem, "not logged in");
    assert.equal((await host.skillsFor("/tmp/scope", "flaky")).problem, undefined);
  });

  // A different answer from "there are none here", which is the reason `ScopeSkills` is an envelope
  // rather than a bare list. pi and Claude both have Skills; a later adapter need not.
  it("reports a problem for an adapter with no notion of Skills", async () => {
    host.registerBackend({
      name: "plain",
      create: async (options) => {
        const session = await backend.create(options);
        // Shadows the prototype's method with an own property, which is the whole of "absent" here.
        return Object.assign(session, { skills: undefined });
      },
    });

    const answer = await host.skillsFor("/tmp/scope", "plain");
    assert.deepEqual(answer.skills, []);
    assert.match(answer.problem ?? "", /no notion of Skills/);
  });

  // What keeps the route off `serve`'s blanket 500 — see `GET /api/skills`.
  it("names an unknown Backend Adapter rather than throwing", async () => {
    assert.deepEqual(await host.skillsFor("/tmp/scope", "nope"), {
      backend: "nope",
      scope: "/tmp/scope",
      skills: [],
      problem: "No backend named nope",
    });
  });
});

/**
 * An Enquiry is the first thing Flow holds a turn open on a human for, so what this block is
 * really testing is that a turn can always end: every path that takes the Backend Session away also
 * closes the question, and no path revives a session to answer one.
 *
 * Mirrors `a Subagent the turn left behind` deliberately, case for case — the two have the same
 * lifecycle problem, and two different-shaped test blocks for one problem is how they drift.
 */
describe("an Enquiry the model asked", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  const QUESTIONS = [
    {
      header: "Library",
      question: "Which library?",
      multiSelect: false,
      options: [{ label: "zod" }, { label: "valibot" }],
    },
  ];

  const enquiryStates = (): string[] =>
    events(host, sessionId)
      .filter((event) => event.type === "enquiry")
      .map((event) => (event.type === "enquiry" ? event.state : ""));

  beforeEach(async () => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.send(sessionId, "go", "now");
  });

  it("forwards an answer to the backend and writes no user_message", async () => {
    const askId = backend.latest.ask(QUESTIONS);
    const before = typesOf(host, sessionId).filter((type) => type === "user_message").length;

    await host.answerEnquiry(sessionId, askId, [["zod"]]);

    assert.deepEqual(backend.latest.answered, [{ askId, answers: [["zod"]] }]);
    assert.deepEqual(enquiryStates(), ["asked", "answered"]);
    // An answer is a tool call's input, not something anyone said to the model — and a turn is
    // already in flight, so there is nothing to occupy and nothing to queue.
    assert.equal(
      typesOf(host, sessionId).filter((type) => type === "user_message").length,
      before,
    );
  });

  it("refuses an askId it cannot find, and leaves nothing behind", async () => {
    backend.latest.ask(QUESTIONS);

    await assert.rejects(
      () => host.answerEnquiry(sessionId, "not-a-real-id", [["zod"]]),
      /no longer open/,
    );
    assert.deepEqual(backend.latest.answered, []);
  });

  it("refuses an answer of the wrong arity rather than sending consent nobody gave", async () => {
    const askId = backend.latest.ask([
      ...QUESTIONS,
      { header: "Features", question: "Which features?", multiSelect: true, options: [{ label: "Caching" }] },
    ]);

    await assert.rejects(() => host.answerEnquiry(sessionId, askId, [["zod"]]), /answered in one act/);
    assert.deepEqual(backend.latest.answered, []);
  });

  it("refuses a second answer to one already answered", async () => {
    const askId = backend.latest.ask(QUESTIONS);
    await host.answerEnquiry(sessionId, askId, [["zod"]]);

    await assert.rejects(() => host.answerEnquiry(sessionId, askId, [["valibot"]]), /no longer open/);
    assert.equal(backend.latest.answered.length, 1);
  });

  it("refuses a backend that does not declare it can ask", async () => {
    const plain = new FakeBackend({ enquiries: false });
    const other = new SessionHost();
    other.registerBackend(plain);
    const id = await other.create({ scope: "/tmp/scope", backend: "fake" });
    await other.send(id, "go", "now");

    await assert.rejects(() => other.answerEnquiry(id, "any", [["zod"]]), /cannot carry an answer/);
  });

  it("is aborted when the Agent Session Settles", async () => {
    backend.latest.ask(QUESTIONS);
    await host.settle(sessionId);

    assert.deepEqual(enquiryStates(), ["asked", "aborted"]);
    const types = typesOf(host, sessionId);
    assert.ok(types.lastIndexOf("enquiry") < types.indexOf("session_settled"));
  });

  it("is aborted when the host shuts down", async () => {
    backend.latest.ask(QUESTIONS);
    await host.shutdown();

    assert.deepEqual(enquiryStates(), ["asked", "aborted"]);
    const types = typesOf(host, sessionId);
    assert.ok(types.lastIndexOf("enquiry") < types.indexOf("session_dormant"));
  });

  it("leaves one that was already answered alone", async () => {
    const askId = backend.latest.ask(QUESTIONS);
    await host.answerEnquiry(sessionId, askId, [["zod"]]);
    await host.shutdown();

    assert.deepEqual(enquiryStates(), ["asked", "answered"], "no second terminal state");
  });

  it("refuses an answer once the session is Dormant, and does not Revive to take one", async () => {
    backend.latest.ask(QUESTIONS);
    const askId = backend.latest.enquiries[0]?.askId ?? "";
    await host.shutdown();
    const sessions = backend.sessions.length;

    /*
     * The deliberate mirror of `compact`, which *does* Revive a Dormant session. What that carries is
     * still meaningful afterwards; this resolves a promise that died with the old Backend Session, so
     * reviving would start a process and spend money to answer nothing.
     */
    await assert.rejects(() => host.answerEnquiry(sessionId, askId, [["zod"]]), /can no longer be answered/);
    assert.equal(host.list().find((summary) => summary.id === sessionId)?.status, "dormant");
    assert.equal(backend.sessions.length, sessions, "no Backend Session was started to answer it");
  });

  it("queues a message sent while one is open rather than steering into the blocked turn", async () => {
    backend.latest.ask(QUESTIONS);

    await host.send(sessionId, "meanwhile", "after_turn");

    // The Agent Session really is running — the turn has not ended and the backend is held — so the
    // Steering Queue does exactly what it does for any other in-flight turn.
    assert.deepEqual(backend.latest.prompts, ["go"]);
    const queued = events(host, sessionId).filter((event) => event.type === "queue_changed");
    assert.deepEqual(queued.at(-1)?.type === "queue_changed" ? queued.at(-1)?.pending : [], ["meanwhile"]);
  });
});

describe("a Permission Prompt the model raised", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;
  /** What was granted a Standing Authorisation, in place of the ConfigStore the daemon passes. */
  let granted: string[];
  /** Set to make the grant fail, which is the interesting failure — see `answerPermission`. */
  let refuseToRemember: Error | undefined;

  const permissionStates = (): string[] =>
    events(host, sessionId)
      .filter((event) => event.type === "permission")
      .map((event) => (event.type === "permission" ? event.state : ""));

  beforeEach(async () => {
    backend = new FakeBackend();
    granted = [];
    refuseToRemember = undefined;
    host = new SessionHost({
      standingAuthorisations: () => granted,
      allowTool: (name) => {
        if (refuseToRemember) throw refuseToRemember;
        granted.push(name);
      },
    });
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
    await host.send(sessionId, "go", "now");
  });

  it("forwards a decision to the backend and writes no user_message", async () => {
    const callId = backend.latest.askPermission("mcp__github__list_issues");
    const before = typesOf(host, sessionId).filter((type) => type === "user_message").length;

    await host.answerPermission(sessionId, callId, "allow");

    assert.deepEqual(backend.latest.decided, [{ callId, decision: "allow" }]);
    assert.deepEqual(permissionStates(), ["asked", "decided"]);
    // A decision is about a tool call the model itself made, and a turn is already in flight — so
    // there is nothing to occupy and nothing to queue.
    assert.equal(
      typesOf(host, sessionId).filter((type) => type === "user_message").length,
      before,
      "a decision is not a message",
    );
  });

  it("hands the standing list to each Backend Session it starts", async () => {
    granted.push("mcp__graphite__run_gt_cmd");
    const revived = await host.create({ scope: "/tmp/scope", backend: "fake" });

    // Read at create rather than watched: ADR 0009 rejected the observer shape a live-updating list
    // would need, so a grant reaches an older session on its next Revive and no sooner.
    assert.deepEqual(backend.latest.standingAuthorisations, ["mcp__graphite__run_gt_cmd"]);
    assert.ok(revived);
  });

  it("remembers an Always as a Standing Authorisation", async () => {
    const callId = backend.latest.askPermission("mcp__gdrive__search_files");

    await host.answerPermission(sessionId, callId, "always");

    assert.deepEqual(granted, ["mcp__gdrive__search_files"]);
  });

  it("remembers nothing for an Allow or a Deny", async () => {
    const allowed = backend.latest.askPermission("Bash");
    await host.answerPermission(sessionId, allowed, "allow");
    const denied = backend.latest.askPermission("WebFetch");
    await host.answerPermission(sessionId, denied, "deny");

    assert.deepEqual(granted, [], "only Always is durable");
  });

  it("reports a failed grant as a notice, not as a refusal", async () => {
    refuseToRemember = new Error("EACCES: config.json");
    const callId = backend.latest.askPermission("Bash");

    /*
     * Partial success, and the register `applyEffort` already uses for this shape. The tool *ran* —
     * the callback was settled before the grant was attempted — so reporting a refusal would be a
     * lie about what happened, and the human would try again against a call that is already gone.
     */
    await host.answerPermission(sessionId, callId, "always");

    const notice = events(host, sessionId).findLast((event) => event.type === "notice");
    assert.match(notice?.type === "notice" ? notice.text : "", /Allowed Bash once/);
    assert.match(notice?.type === "notice" ? notice.text : "", /EACCES/);
    assert.deepEqual(permissionStates(), ["asked", "decided"], "the decision still stands");
  });

  it("refuses a callId nothing is waiting under", async () => {
    backend.latest.askPermission("Bash");
    await assert.rejects(
      () => host.answerPermission(sessionId, "nobody", "allow"),
      /no longer waiting to be authorised/,
    );
  });

  it("refuses a second decision on the same call, and remembers nothing for it", async () => {
    const callId = backend.latest.askPermission("Bash");
    await host.answerPermission(sessionId, callId, "allow");

    // The adapter answers `false`, which is both an ordinary race and the signal to persist nothing:
    // a stale Always must not leave a Standing Authorisation behind.
    await assert.rejects(
      () => host.answerPermission(sessionId, callId, "always"),
      /no longer waiting to be authorised/,
    );
    assert.deepEqual(granted, []);
  });

  it("refuses a decision for a backend that cannot be asked before it acts", async () => {
    const cannot = new FakeBackend({ permissions: false });
    const other = new SessionHost();
    other.registerBackend(cannot);
    const id = await other.create({ scope: "/tmp/scope", backend: "fake" });

    // The flag, never the method — so an adapter cannot be half-capable and a client that hides its
    // affordance on the flag cannot reach a method that is not there.
    assert.equal(cannot.latest.answerPermission, undefined);
    await assert.rejects(() => other.answerPermission(id, "c1", "allow"), /cannot be asked before it acts/);
  });

  it("closes an open prompt as aborted before the session_settled line", async () => {
    backend.latest.askPermission("Bash");

    await host.settle(sessionId);

    const types = typesOf(host, sessionId);
    const aborted = types.lastIndexOf("permission");
    // Ordering, not merely presence: a terminal state arriving after the marker would reduce a pane
    // back out of Settled, and a prompt left `asked` would lock the composer on a replayed
    // transcript.
    assert.ok(aborted < types.indexOf("session_settled"), "the prompt is closed first");
    assert.deepEqual(permissionStates(), ["asked", "aborted"]);
  });

  it("leaves one that was already decided alone", async () => {
    const callId = backend.latest.askPermission("Bash");
    await host.answerPermission(sessionId, callId, "allow");
    await host.shutdown();

    assert.deepEqual(permissionStates(), ["asked", "decided"], "no second terminal state");
  });

  it("refuses a decision once the session is Dormant, and does not Revive to take one", async () => {
    const callId = backend.latest.askPermission("Bash");
    await host.shutdown();
    const sessions = backend.sessions.length;

    // The mirror of `answerEnquiry`, and for the same reason: this settles a promise that died with
    // the old Backend Session, so reviving would spend money to authorise nothing.
    await assert.rejects(
      () => host.answerPermission(sessionId, callId, "allow"),
      /can no longer be authorised/,
    );
    assert.equal(host.list().find((summary) => summary.id === sessionId)?.status, "dormant");
    assert.equal(backend.sessions.length, sessions, "no Backend Session was started to decide it");
  });
});

/**
 * The lifecycle/activity split, from the outside: what `statusOf` and `list()` report, and when the
 * rail's sort key moves. Its own fixture, because these turn on one Agent Session's whole history.
 */
describe("what an Agent Session is doing", () => {
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake" });
  });


/**
 * Awaiting: the derived status for a turn held open on a person rather than on a model.
 *
 * The Lifecycle is stored and the activity is worked out, so these assert the derivation rather
 * than a field anyone assigned — and in particular that `turnInFlight` is untouched by it, since
 * that is what the Steering Queue reads.
 */
describe("awaiting a person", () => {
  it("reports Awaiting while a Permission Prompt is open, without freeing the Steering Queue", async () => {
    await host.send(sessionId, "go", "now");
    backend.latest.askPermission("Bash");

    assert.equal(host.statusOf(sessionId), "awaiting");

    // The turn is still in flight, so a second send queues rather than jumping into it. This is
    // the assertion that the split did not disturb ADR 0002.
    await host.send(sessionId, "second", "after_turn");
    assert.deepEqual(backend.latest.prompts, ["go"], "the queued message must not reach the backend");
  });

  it("reports Awaiting while an Enquiry is open, and Running again once it is answered", async () => {
    await host.send(sessionId, "go", "now");
    const askId = backend.latest.ask([
      { header: "Pick", question: "Which?", multiSelect: false, options: [{ label: "a" }, { label: "b" }] },
    ]);
    assert.equal(host.statusOf(sessionId), "awaiting");

    await host.answerEnquiry(sessionId, askId, [["a"]]);
    assert.equal(host.statusOf(sessionId), "running", "the model has the turn back");

    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.statusOf(sessionId), "idle");
  });

  it("stays Awaiting until the last of several Permission Prompts is decided", async () => {
    await host.send(sessionId, "go", "now");
    const first = backend.latest.askPermission("Bash");
    const second = backend.latest.askPermission("Write");

    await host.answerPermission(sessionId, first, "allow");
    assert.equal(host.statusOf(sessionId), "awaiting", "one prompt is still open");

    await host.answerPermission(sessionId, second, "allow");
    assert.equal(host.statusOf(sessionId), "running");
  });

  it("returns to Idle when a turn ends with a prompt the adapter never closed", async () => {
    await host.send(sessionId, "go", "now");
    backend.latest.askPermission("Bash");
    assert.equal(host.statusOf(sessionId), "awaiting");

    // No terminal snapshot for the prompt — only the turn ending. A torn turn that left the index
    // set would pin this Agent Session at Awaiting for good.
    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.statusOf(sessionId), "idle");
  });
});

/**
 * ADR 0016: a backgrounded Subagent is not occupancy. It travels as a count so a rail can say
 * work is happening, and it must never make the Agent Session look busy — the Steering Queue
 * would then refuse to dispatch into a model that is sitting idle.
 */
describe("counting Subagents without taking occupancy", () => {
  it("counts running and waiting Subagents, and dedupes a repeated snapshot", async () => {
    await host.send(sessionId, "go", "now");
    const explore = backend.latest.beginSubagent("Explore");
    const plan = backend.latest.beginSubagent("Plan");
    explore.resume();
    explore.resume();

    assert.equal(host.list().find((summary) => summary.id === sessionId)?.activeSubagents, 2);

    plan.wait("provider");
    assert.equal(
      host.list().find((summary) => summary.id === sessionId)?.activeSubagents,
      2,
      "waiting is still working",
    );

    explore.finish();
    plan.finish();
    assert.equal(host.list().find((summary) => summary.id === sessionId)?.activeSubagents, 0);
  });

  it("leaves a session with only background Subagents Idle, and counts them", async () => {
    await host.send(sessionId, "go", "now");
    const explore = backend.latest.beginSubagent("Explore");
    explore.launch();
    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    const summary = host.list().find((entry) => entry.id === sessionId);
    // The model really is idle and steering really does work, so the status says so (ADR 0016).
    // What is true — that work is happening — is the count, and nothing else.
    assert.equal(summary?.status, "idle");
    assert.equal(summary?.activeSubagents, 1);
  });
});

/**
 * The same index for Background Calls (ADR 0021), and the same guarantee: a backgrounded `Bash`
 * says work is happening without ever saying the model is busy.
 */
describe("counting Background Calls without taking occupancy", () => {
  it("leaves a session with only Background Calls Idle, and counts them", async () => {
    await host.send(sessionId, "go", "now");
    backend.latest.backgroundCall();
    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    const summary = host.list().find((entry) => entry.id === sessionId);
    assert.equal(summary?.status, "idle", "the model is idle, and steering into it must work");
    assert.equal(summary?.activeBackgroundCalls, 1);
    assert.equal(summary?.activeSubagents, 0, "a Background Call is not a Subagent");
  });

  it("dispatches the next message while a Background Call is still running", async () => {
    /*
     * The regression that matters most. If a Background Call ever took occupancy, this send would
     * queue instead of dispatching — the human's message would sit there looking ignored until a
     * `Bash` they launched minutes ago happened to report. `BackgroundCalls` has no counterpart to
     * `Subagents.hold` by construction, and this is what asserts that stayed true.
     */
    await host.send(sessionId, "one", "now");
    backend.latest.backgroundCall();
    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    await host.send(sessionId, "two", "after_turn");

    assert.deepEqual(backend.latest.prompts, ["one", "two"], "the Call must not hold the queue");
  });

  it("counts several, dedupes a repeated snapshot, and drops each as it settles", async () => {
    await host.send(sessionId, "go", "now");
    const one = backend.latest.backgroundCall("Bash");
    const two = backend.latest.backgroundCall("Monitor");
    one.snapshot({ state: "running" });

    assert.equal(host.list().find((entry) => entry.id === sessionId)?.activeBackgroundCalls, 2);

    one.settle();
    assert.equal(host.list().find((entry) => entry.id === sessionId)?.activeBackgroundCalls, 1);
    two.settle("aborted");
    assert.equal(host.list().find((entry) => entry.id === sessionId)?.activeBackgroundCalls, 0);
  });
});

/**
 * How the rail is ordered: banded by how alive an Agent Session is, then by when it last came to
 * rest inside each band. Nothing may move a row while a turn merely streams.
 */
describe("ordering the rail", () => {
  const restAt = (id: string) => host.list().find((summary) => summary.id === id)?.restingAt;
  const order = () => host.list().map((summary) => summary.id);
  // Two stamps inside one ISO millisecond tie, and the sort then falls back to insertion order.
  // Real work is never that close together; these tests are.
  const gap = () => new Promise((resolve) => setTimeout(resolve, 2));

  it("does not move while a turn streams, though updatedAt does", async () => {
    const atRest = restAt(sessionId);
    await host.send(sessionId, "go", "now");
    for (let index = 0; index < 50; index += 1) backend.latest.say(`chunk ${index}`, false);

    assert.equal(restAt(sessionId), atRest, "a streaming turn must not restamp anything");
  });

  it("stamps when the turn ends, and not when a prompt wants a decision", async () => {
    const atRest = restAt(sessionId);
    await gap();
    await host.send(sessionId, "go", "now");
    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    const afterTurn = restAt(sessionId);
    assert.ok(afterTurn !== undefined && atRest !== undefined && afterTurn > atRest);

    await gap();
    await host.send(sessionId, "again", "now");
    backend.latest.askPermission("Bash");
    // Awaiting is its owner's turn, but the band is what surfaces it. Stamping here would mean this
    // Agent Session jumped the running band on its way back out of the prompt.
    assert.equal(restAt(sessionId), afterTurn, "Awaiting must not restamp");
  });

  it("keeps a working Agent Session above one that has finished", async () => {
    await gap();
    const other = await host.create({ scope: "/tmp/other", backend: "fake" });
    const mine = backend.sessions.at(-2);
    assert.ok(mine);

    // Both Idle, so recency alone decides and the newer one leads.
    assert.deepEqual(order(), [other, sessionId]);

    await host.send(sessionId, "long turn", "now");
    for (let index = 0; index < 20; index += 1) mine.say(`chunk ${index}`, false);
    await gap();
    assert.deepEqual(
      order(),
      [sessionId, other],
      "a Running Agent Session sits above an Idle one however stale it is",
    );

    mine.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order(), [sessionId, other], "and holds its place on finishing, now by recency");
  });

  it("lifts an Agent Session awaiting a person above everything working", async () => {
    await gap();
    const other = await host.create({ scope: "/tmp/other", backend: "fake" });
    const mine = backend.sessions.at(-2);
    assert.ok(mine);

    // `other` is Running, and would lead on both band and recency.
    await host.send(other, "work", "now");
    await gap();
    assert.deepEqual(order(), [other, sessionId]);

    // `sessionId` is older and its restingAt is staler, so only the band can lift it.
    await host.send(sessionId, "go", "now");
    mine.askPermission("Bash");
    assert.equal(host.statusOf(sessionId), "awaiting");
    assert.deepEqual(order(), [sessionId, other], "the one that needs a person comes first");
  });

  it("bands background Subagents as working, though the status stays idle", async () => {
    await gap();
    const other = await host.create({ scope: "/tmp/other", backend: "fake" });
    const mine = backend.sessions.at(-2);
    assert.ok(mine);
    assert.deepEqual(order(), [other, sessionId], "precondition: the newer one leads");

    await host.send(sessionId, "explore", "now");
    const explore = mine.beginSubagent("Explore");
    explore.launch();
    mine.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    // ADR 0016 keeps the status honest — the model is idle — and the band keeps the row where its
    // owner can watch it, which is the whole reason the count travels separately.
    assert.equal(host.statusOf(sessionId), "idle");
    assert.deepEqual(order(), [sessionId, other], "work happening beats an Idle Agent Session");

    explore.finish();

    // Give `other` the newer rest stamp, so recency alone would put it first. While the Subagent
    // was working the band overrode that; now that it is done, nothing does.
    await gap();
    await host.send(other, "something", "now");
    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order(), [other, sessionId], "and it drops back once the Subagent is done");
  });

  it("sinks Dormant below Idle, and Settled below both", async () => {
    await gap();
    const dormant = await host.create({ scope: "/tmp/dormant", backend: "fake" });
    await gap();
    const settled = await host.create({ scope: "/tmp/settled", backend: "fake" });
    await host.settle(settled);
    await host.shutdown();
    // shutdown() takes every Backend Session away, so revive the one that must read as Idle.
    await host.revive(sessionId);

    assert.equal(host.statusOf(sessionId), "idle");
    assert.equal(host.statusOf(dormant), "dormant");
    assert.equal(host.statusOf(settled), "settled");
    assert.deepEqual(order(), [sessionId, dormant, settled]);
  });
});

it("refuses a branch switch while a Permission Prompt holds the turn", async () => {
  // The regression this guards: `switchBranch` used to read `status === "running"`, which stops
  // being true the moment a prompt makes the derived status Awaiting — so git would have moved
  // the working tree out from under a live tool call.
  await host.send(sessionId, "go", "now");
  backend.latest.askPermission("Bash");
  assert.equal(host.statusOf(sessionId), "awaiting");

  await assert.rejects(() => host.switchBranch(sessionId, "other"), /abort the turn/);
});
});
