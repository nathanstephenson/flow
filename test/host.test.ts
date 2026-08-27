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
    assert.deepEqual(typesOf(host, sessionId), ["session_started", "user_message", "turn_started"]);
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
