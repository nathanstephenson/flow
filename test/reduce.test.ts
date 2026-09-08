import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialState, reduceAll, type Entry, type ViewState } from "../src/client/reduce.ts";
import { SessionLog } from "../src/daemon/log.ts";
import type { AgentEvent, LoggedEvent } from "../src/protocol/events.ts";

const CAPS = { providers: ["fake"], models: [], compaction: false, fork: false, subagents: false };

function transcript(...events: AgentEvent[]): SessionLog {
  const log = new SessionLog("s1");
  // Fixed timestamp: the reducer must not depend on wall-clock.
  for (const event of events) log.append(event, "2026-01-01T00:00:00.000Z");
  return log;
}

const SAMPLE: AgentEvent[] = [
  { type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS },
  { type: "user_message", id: "u1", text: "hello" },
  { type: "turn_started", turnId: "t1" },
  { type: "message", id: "m1", text: "par", final: false },
  { type: "tool_started", callId: "c1", name: "Read", input: { path: "a.ts" } },
  { type: "message", id: "m1", text: "partial then whole", final: true },
  { type: "tool_ended", callId: "c1", result: "contents", isError: false },
  { type: "context_usage", used: 1200, window: 200000 },
  { type: "turn_ended", turnId: "t1", reason: "complete" },
];

describe("reduce", () => {
  it("upserts snapshots by id rather than appending each update", () => {
    const state = reduceAll(transcript(...SAMPLE).since(0));
    const assistant = state.entries.filter((entry) => entry.kind === "assistant");
    assert.equal(assistant.length, 1, "two message events with one id must collapse to one entry");
    assert.equal(assistant[0]?.kind === "assistant" ? assistant[0].text : "", "partial then whole");
  });

  it("keeps the Effort in force", () => {
    const state = reduceAll(
      transcript(
        { type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS },
        { type: "effort_changed", effort: "high" },
        { type: "effort_changed", effort: "low" },
      ).since(0),
    );
    assert.equal(state.effort, "low");
  });

  it("is deterministic across replays", () => {
    const log = transcript(...SAMPLE);
    assert.deepEqual(reduceAll(log.since(0)), reduceAll(log.since(0)));
  });

  it("converges whether a client streams from the start or joins late", () => {
    const log = transcript(...SAMPLE);
    const all = reduceAll(log.since(0));

    const split = 4;
    const caughtUp = reduceAll(log.since(split), reduceAll(log.since(0).slice(0, split)));

    assert.deepEqual(caughtUp, all, "since(N) replay must land in the same state");
  });

  it("tracks tool lifecycle and marks errors", () => {
    const state = reduceAll(
      transcript(
        { type: "tool_started", callId: "c1", name: "Bash", input: "ls" },
        { type: "tool_ended", callId: "c1", result: "boom", isError: true },
      ).since(0),
    );
    const tool = state.entries.find((entry) => entry.kind === "tool");
    assert.equal(tool?.kind === "tool" ? tool.status : "", "error");
  });

  it("shows a Settled Agent Session as settled, and clears its queue", () => {
    const state = reduceAll(
      transcript(
        { type: "queue_changed", pending: ["a"] },
        { type: "session_settled" },
      ).since(0),
    );
    assert.equal(state.status, "settled");
    assert.deepEqual(state.queue, []);
    assert.equal(state.entries.at(-1)?.kind, "marker");
  });

  it("records going Dormant, Settling and Reviving as markers rather than as notices", () => {
    const state = reduceAll(
      transcript(
        { type: "session_dormant", reason: "host shutdown" },
        { type: "revived", fromSeq: 1 },
        { type: "session_settled" },
        { type: "notice", level: "warn", text: "a message about the Agent Session" },
      ).since(0),
    );

    // A front-end must be able to tell a break in an Agent Session's life from a message about it
    // without sniffing the text it happens to carry.
    assert.deepEqual(
      state.entries.map((entry) => (entry.kind === "marker" ? entry.marker : entry.kind)),
      ["dormant", "revived", "settled", "notice"],
    );
    assert.deepEqual(
      state.entries.flatMap((entry) => (entry.kind === "marker" ? [entry.text] : [])),
      ["Dormant: host shutdown", "Revived from seq 1", "Settled"],
    );
  });

  it("returns a Settled Agent Session to idle when it is revived", () => {
    const state = reduceAll(
      transcript({ type: "session_settled" }, { type: "revived", fromSeq: 1 }).since(0),
    );
    assert.equal(state.status, "idle");
  });

  it("carries a user message's attachment ids onto its Entry", () => {
    const state = reduceAll(
      transcript({ type: "user_message", id: "u1", text: "what is this?", attachments: ["a.png", "b.jpg"] }).since(0),
    );
    const [entry] = state.entries;
    assert.equal(entry?.kind, "user");
    assert.deepEqual(entry?.kind === "user" ? entry.attachments : [], ["a.png", "b.jpg"]);
  });

  /*
   * Absent rather than an empty array, so a front-end's `attachments?.length` test is the whole of
   * the decision and there is no second falsy shape to remember.
   */
  it("leaves attachments off an Entry for a message that carried none", () => {
    const state = reduceAll(transcript({ type: "user_message", id: "u1", text: "hello" }).since(0));
    assert.equal(state.entries[0]?.kind === "user" && "attachments" in state.entries[0], false);
  });

  it("keeps queue depth in view state", () => {
    const state = reduceAll(transcript({ type: "queue_changed", pending: ["a", "b"] }).since(0));
    assert.deepEqual(state.queue, ["a", "b"]);
  });

  it("does not mutate the state it is given", () => {
    const start = initialState();
    const frozen = JSON.stringify(start);
    reduceAll(transcript(...SAMPLE).since(0), start);
    assert.equal(JSON.stringify(start), frozen);
  });

  it("tracks lastSeq so a client knows where to resume", () => {
    const state = reduceAll(transcript(...SAMPLE).since(0));
    assert.equal(state.lastSeq, SAMPLE.length);
  });
});

describe("the branch a Scope is on", () => {
  it("lands on the view state, and is replaced rather than accumulated", () => {
    const state = reduceAll(
      transcript(
        { type: "branch_changed", branch: { name: "main" } },
        { type: "branch_changed", branch: { name: "feature" } },
      ).since(0),
    );
    assert.deepEqual(state.branch, { name: "feature" });
  });

  it("carries a detached HEAD as a commit rather than as a branch", () => {
    const state = reduceAll(
      transcript({ type: "branch_changed", branch: { name: "a1b2c3d", detached: true } }).since(0),
    );
    assert.deepEqual(state.branch, { name: "a1b2c3d", detached: true });
  });

  // Absent is the signal a front-end hides its control on, so it must not become a falsy branch.
  it("is absent until something says otherwise", () => {
    assert.equal(initialState().branch, undefined);
    const started = reduceAll(
      transcript({ type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS }).since(0),
    );
    assert.equal(started.branch, undefined);
  });

  it("carries whether the Scope is a worktree, so a client can still name the Project", () => {
    const plain = reduceAll(
      transcript({ type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS }).since(0),
    );
    assert.equal(plain.worktree, undefined);

    const cut = reduceAll(
      transcript({
        type: "session_started",
        backend: "fake",
        scope: "/s/worktrees/api/main-1",
        capabilities: CAPS,
        worktree: true,
      }).since(0),
    );
    assert.equal(cut.worktree, true);
  });
});

/**
 * A Subagent reduces to a flat, top-level Entry beside the tool call that spawned it (ADR 0015).
 *
 * The invariant these protect is `entries.length`: `web/src/store/agent-session-view.ts` decides the
 * key list changed by length alone, sound only while the transcript is append-only. A Subagent's
 * whole life must therefore add exactly one Entry, however many snapshots it takes to get there.
 */
describe("a Subagent in the Presentation Transcript", () => {
  const at = (seq: number, event: AgentEvent): LoggedEvent => ({ seq, sessionId: "s1", at: "", event });

  const lifecycle = (...states: AgentEvent[]): ViewState =>
    reduceAll(states.map((event, index) => at(index + 1, event)));

  it("collapses every snapshot into one Entry", () => {
    const view = lifecycle(
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "running" },
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "waiting", on: "provider" },
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "running" },
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "complete" },
    );

    assert.equal(view.entries.length, 1, "the length heuristic in the web store depends on this");
    const entry = view.entries[0];
    assert.equal(entry?.kind === "subagent" && entry.status, "complete");
  });

  it("drops waitingOn once it is no longer waiting", () => {
    const view = lifecycle(
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "waiting", on: "permission" },
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "running" },
    );
    const entry = view.entries[0];
    assert.equal(entry?.kind === "subagent" && entry.waitingOn, undefined, "a stale wait is a lie");
  });

  it("sits beside the tool call it shares an id with, not inside it", () => {
    const view = lifecycle(
      { type: "tool_started", callId: "call_1", name: "Agent", input: {} },
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "running" },
    );
    assert.deepEqual(view.entries.map((entry: Entry) => entry.kind), ["tool", "subagent"]);
    assert.deepEqual(view.entries.map((entry: Entry) => entry.id), ["call_1", "call_1"]);
  });

  it("attributes a Subagent's message to it, at the top level", () => {
    const view = lifecycle(
      { type: "subagent", subagentId: "call_1", name: "explorer", state: "running" },
      { type: "message", id: "m1", text: "reading", final: true, producer: { subagentId: "call_1" } },
      { type: "message", id: "m2", text: "parent", final: true },
    );

    assert.deepEqual(view.entries.map((entry) => entry.kind), ["subagent", "assistant", "assistant"]);
    const child = view.entries[1];
    const parent = view.entries[2];
    assert.deepEqual(child?.kind === "assistant" && child.producer, { subagentId: "call_1" });
    assert.equal(parent?.kind === "assistant" && parent.producer, undefined);
  });

  it("keeps a parent and a Subagent streaming at once from stealing each other's text", () => {
    const view = lifecycle(
      { type: "message", id: "m1", text: "parent par", final: false },
      { type: "message", id: "m2", text: "child ", final: false, producer: { subagentId: "call_1" } },
      { type: "message", id: "m1", text: "parent partial", final: true },
      { type: "message", id: "m2", text: "child done", final: true, producer: { subagentId: "call_1" } },
    );
    assert.deepEqual(
      view.entries.map((entry) => (entry.kind === "assistant" ? entry.text : "")),
      ["parent partial", "child done"],
    );
  });
});
