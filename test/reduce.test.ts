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

/**
 * The active-Subagent count, which the Composer strip reads through Chrome.
 *
 * Snapshots repeat, so the count has to move on the *transition* and not on each arrival — a
 * Subagent reporting `running` twice must not count twice. Carried on ViewState rather than derived,
 * because deriving it in the client would scan the whole transcript every frame while a subagent
 * streams.
 */
describe("counting the Subagents that are still working", () => {
  const at = (seq: number, event: AgentEvent): LoggedEvent => ({ seq, sessionId: "s1", at: "", event });
  const run = (...events: AgentEvent[]): ViewState =>
    reduceAll(events.map((event, index) => at(index + 1, event)));
  const snap = (id: string, state: "running" | "complete" | "aborted" | "error"): AgentEvent => ({
    type: "subagent",
    subagentId: id,
    name: "Explore",
    state,
  });

  it("starts at zero", () => {
    assert.equal(initialState().activeSubagents, 0);
  });

  it("counts one that is running", () => {
    assert.equal(run(snap("a", "running")).activeSubagents, 1);
  });

  it("does not count a repeated snapshot twice", () => {
    // The bug this guards: snapshots are latest-wins and arrive repeatedly, so counting arrivals
    // rather than transitions would climb forever while a subagent works.
    assert.equal(run(snap("a", "running"), snap("a", "running"), snap("a", "running")).activeSubagents, 1);
  });

  it("counts a waiting Subagent as still working", () => {
    const view = run({ type: "subagent", subagentId: "a", name: "Explore", state: "waiting", on: "permission" });
    assert.equal(view.activeSubagents, 1);
  });

  it("drops it again when it finishes", () => {
    assert.equal(run(snap("a", "running"), snap("a", "complete")).activeSubagents, 0);
    assert.equal(run(snap("a", "running"), snap("a", "aborted")).activeSubagents, 0);
    assert.equal(run(snap("a", "running"), snap("a", "error")).activeSubagents, 0);
  });

  it("does not go negative when a terminal snapshot repeats", () => {
    assert.equal(run(snap("a", "running"), snap("a", "complete"), snap("a", "complete")).activeSubagents, 0);
  });

  it("counts several at once, and each one leaving", () => {
    assert.equal(run(snap("a", "running"), snap("b", "running"), snap("c", "running")).activeSubagents, 3);
    assert.equal(run(snap("a", "running"), snap("b", "running"), snap("a", "complete")).activeSubagents, 1);
  });

  it("survives running, waiting and back again", () => {
    const view = run(
      snap("a", "running"),
      { type: "subagent", subagentId: "a", name: "Explore", state: "waiting", on: "provider" },
      snap("a", "running"),
      snap("a", "complete"),
    );
    assert.equal(view.activeSubagents, 0);
  });
});

/**
 * An event this build has never heard of.
 *
 * A Presentation Transcript is durable and replayed in full forever (ADR 0001), so it outlives the
 * vocabulary that wrote it: a rename leaves older lines behind, and a newer daemon can write lines
 * an older client has never seen. Before this, such a line fell through applyEvent's switch and the
 * spread of its undefined return replaced the whole view with `{ lastSeq }` — one unrecognised
 * event silently emptied a session that had rendered fine a moment earlier.
 */
describe("an event from a vocabulary this build does not have", () => {
  const unknown = { type: "an_event_from_the_future" } as unknown as AgentEvent;

  it("leaves everything already reduced in place", () => {
    const before = reduceAll(transcript(...SAMPLE).since(0));
    const after = reduceAll(transcript(...SAMPLE, unknown).since(0));

    assert.equal(after.status, before.status);
    assert.equal(after.scope, before.scope);
    assert.equal(after.backend, before.backend);
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.contextUsage, before.contextUsage);
  });

  it("still advances lastSeq, because the event was consumed", () => {
    // Otherwise a client resuming at `since` asks for it again on every reconnect, forever.
    const after = reduceAll(transcript(...SAMPLE, unknown).since(0));
    assert.equal(after.lastSeq, SAMPLE.length + 1);
  });

  it("survives a transcript written before the Subagent rename", () => {
    // The concrete case: three transcripts on disk carry `type: "delegation"` from the old
    // vocabulary, and they must still open.
    const legacy = { type: "delegation", delegationId: "call_1", name: "Explore", state: "running" };
    const state = reduceAll(
      transcript(
        { type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS },
        legacy as unknown as AgentEvent,
        { type: "user_message", id: "u1", text: "after the unknown line" },
      ).since(0),
    );

    assert.equal(state.scope, "/tmp", "the session must not be emptied by a line it cannot read");
    assert.equal(state.entries.filter((entry) => entry.kind === "user").length, 1);
    assert.equal(state.activeSubagents, 0, "an unreadable subagent line counts for nothing");
  });
});
