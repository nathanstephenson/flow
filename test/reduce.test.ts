import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialState, reduce, reduceAll, type Entry, type ViewState } from "../src/client/reduce.ts";
import { SessionLog } from "../src/daemon/log.ts";
import type { AgentEvent, LoggedEvent } from "../src/protocol/events.ts";

const CAPS = { providers: ["fake"], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false };

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
 * The same counting for Background Calls (ADR 0021), plus the one question that is not a mirror:
 * whether the two counts can contaminate each other.
 */
describe("counting the Background Calls that are still running", () => {
  const at = (seq: number, event: AgentEvent): LoggedEvent => ({ seq, sessionId: "s1", at: "2026-01-01T00:00:00Z", event });
  const run = (...events: AgentEvent[]): ViewState =>
    reduceAll(events.map((event, index) => at(index + 1, event)));
  const snap = (id: string, state: "running" | "complete" | "aborted" | "error"): AgentEvent => ({
    type: "background_call",
    callId: id,
    tool: "Bash",
    state,
  });

  it("starts at zero", () => {
    assert.equal(initialState().activeBackgroundCalls, 0);
  });

  it("counts one that is running, and drops it on each terminal word", () => {
    assert.equal(run(snap("a", "running")).activeBackgroundCalls, 1);
    assert.equal(run(snap("a", "running"), snap("a", "complete")).activeBackgroundCalls, 0);
    assert.equal(run(snap("a", "running"), snap("a", "aborted")).activeBackgroundCalls, 0);
    assert.equal(run(snap("a", "running"), snap("a", "error")).activeBackgroundCalls, 0);
  });

  it("does not count a repeated snapshot twice", () => {
    assert.equal(run(snap("a", "running"), snap("a", "running")).activeBackgroundCalls, 1);
  });

  it("does not go negative when a terminal snapshot repeats", () => {
    // Not hypothetical: a Call settles through `task_updated` *and* `task_notification`, so the
    // terminal snapshot really does arrive twice.
    assert.equal(run(snap("a", "running"), snap("a", "complete"), snap("a", "complete")).activeBackgroundCalls, 0);
  });

  it("counts several at once, and each one leaving", () => {
    assert.equal(run(snap("a", "running"), snap("b", "running")).activeBackgroundCalls, 2);
    assert.equal(run(snap("a", "running"), snap("b", "running"), snap("a", "complete")).activeBackgroundCalls, 1);
  });

  it("keeps the two counts apart", () => {
    /*
     * The adapter routes a settled task to one lifecycle or the other on a single predicate, and
     * that routing has no client-side counterpart — so if the arms ever shared a counter, nothing
     * downstream would catch it.
     */
    const call = run(snap("a", "running"));
    assert.equal(call.activeSubagents, 0, "a Background Call is not a Subagent");

    const agent = reduceAll([
      at(1, { type: "subagent", subagentId: "a", name: "Explore", state: "running" }),
    ]);
    assert.equal(agent.activeBackgroundCalls, 0, "and a Subagent is not a Background Call");
  });

  it("takes no occupancy, so the Agent Session stays Idle", () => {
    // ADR 0016's guarantee, restated for ADR 0021: the model is idle and the Steering Queue may
    // dispatch. A Background Call that made this `running` would block steering.
    assert.equal(run(snap("a", "running")).status, "idle");
  });

  it("holds when a Call started rather than resetting it on every snapshot", () => {
    const view = run(snap("a", "running"), snap("a", "running"));
    const entry = view.entries.find((candidate) => candidate.kind === "background_call");
    assert.equal(entry?.kind === "background_call" ? entry.startedAt : undefined, "2026-01-01T00:00:00Z");
    assert.equal(entry?.kind === "background_call" ? entry.endedAt : "unset", undefined, "still running");
  });

  it("stamps an end once the Call stops", () => {
    const view = run(snap("a", "running"), snap("a", "complete"));
    const entry = view.entries.find((candidate) => candidate.kind === "background_call");
    assert.equal(entry?.kind === "background_call" ? entry.endedAt : undefined, "2026-01-01T00:00:00Z");
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

/**
 * When a Subagent started and stopped.
 *
 * The only Entry that carries time, taken from the event's own `at` — which the store otherwise
 * discards, and which is why this was not possible before.
 */
describe("timing a Subagent", () => {
  const at = (iso: string, event: AgentEvent): LoggedEvent => ({ seq: 1, sessionId: "s1", at: iso, event });
  const snap = (state: "running" | "complete"): AgentEvent => ({
    type: "subagent",
    subagentId: "a",
    name: "Explore",
    state,
  });
  const only = (view: ViewState) => {
    const entry = view.entries.find((candidate) => candidate.kind === "subagent");
    return entry?.kind === "subagent" ? entry : undefined;
  };
  const run = (...steps: [string, AgentEvent][]): ViewState => {
    let state = initialState();
    steps.forEach(([iso, event], index) => {
      state = reduce(state, { ...at(iso, event), seq: index + 1 });
    });
    return state;
  };

  it("records when it was first reported", () => {
    const view = run(["2026-01-01T00:00:00.000Z", snap("running")]);
    assert.equal(only(view)?.startedAt, "2026-01-01T00:00:00.000Z");
  });

  it("keeps the original start across every later snapshot", () => {
    // The bug this guards: taking `at` on each arrival resets the clock, so a Subagent that worked
    // for a minute reads as having started a moment ago.
    const view = run(
      ["2026-01-01T00:00:00.000Z", snap("running")],
      ["2026-01-01T00:00:30.000Z", snap("running")],
      ["2026-01-01T00:01:00.000Z", snap("running")],
    );
    assert.equal(only(view)?.startedAt, "2026-01-01T00:00:00.000Z");
  });

  it("has no end while it is still working", () => {
    const view = run(["2026-01-01T00:00:00.000Z", snap("running")]);
    assert.equal(only(view)?.endedAt, undefined);
  });

  it("records the end, keeping the start", () => {
    const view = run(
      ["2026-01-01T00:00:00.000Z", snap("running")],
      ["2026-01-01T00:01:15.000Z", snap("complete")],
    );
    assert.equal(only(view)?.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(only(view)?.endedAt, "2026-01-01T00:01:15.000Z");
  });

  it("keeps the first end when a terminal snapshot repeats", () => {
    const view = run(
      ["2026-01-01T00:00:00.000Z", snap("running")],
      ["2026-01-01T00:01:00.000Z", snap("complete")],
      ["2026-01-01T00:02:00.000Z", snap("complete")],
    );
    assert.equal(only(view)?.endedAt, "2026-01-01T00:01:00.000Z");
  });

  it("clears the end if it somehow resumes, so a live Subagent shows none", () => {
    const view = run(
      ["2026-01-01T00:00:00.000Z", snap("running")],
      ["2026-01-01T00:01:00.000Z", snap("complete")],
      ["2026-01-01T00:02:00.000Z", snap("running")],
    );
    assert.equal(only(view)?.endedAt, undefined);
    assert.equal(only(view)?.startedAt, "2026-01-01T00:00:00.000Z");
  });
});

describe("an Enquiry in the transcript", () => {
  const QUESTIONS = [
    {
      header: "Library",
      question: "Which library?",
      multiSelect: false,
      options: [{ label: "zod" }, { label: "valibot" }],
    },
  ];

  const asked: AgentEvent = { type: "enquiry", askId: "a1", questions: QUESTIONS, state: "asked" };

  it("upserts in place, so its whole life is one row", () => {
    const state = reduceAll(
      transcript(
        { type: "turn_started", turnId: "t1" },
        { type: "tool_started", callId: "a1", name: "AskUserQuestion", input: { questions: QUESTIONS } },
        asked,
        asked,
        { type: "enquiry", askId: "a1", questions: QUESTIONS, state: "answered", answers: [["zod"]] },
      ).since(0),
    );

    const rows = state.entries.filter((entry) => entry.kind === "enquiry");
    assert.equal(rows.length, 1, "three snapshots, one row");
    assert.equal(rows[0]?.kind === "enquiry" ? rows[0].status : "", "answered");
    assert.deepEqual(rows[0]?.kind === "enquiry" ? rows[0].answers : [], [["zod"]]);
  });

  it("holds the same `asking` reference across repeated snapshots", () => {
    /*
     * The property the whole web chrome rests on. `asking` reaches a shallow-compared snapshot, so a
     * repeated `asked` that minted a fresh object would republish the chrome on every one — the trap
     * `activeSubagents` is a count to avoid.
     */
    const log = transcript(asked, asked);
    const entries = log.since(0);
    const once = reduce(initialState(), entries[0] as LoggedEvent);
    const twice = reduce(once, entries[1] as LoggedEvent);

    assert.ok(once.asking !== undefined);
    assert.equal(once.asking, twice.asking, "the same object, not an equal one");
  });

  it("carries the answers on the Entry rather than leaving them to the tool result", () => {
    // The SDK writes its tool result as prose, so a front-end reading that would be parsing an
    // English sentence to recover what its own user clicked.
    const state = reduceAll(
      transcript(asked, {
        type: "enquiry",
        askId: "a1",
        questions: QUESTIONS,
        state: "answered",
        answers: [["Neither — something I typed"]],
      }).since(0),
    );

    const row = state.entries.find((entry) => entry.kind === "enquiry");
    assert.deepEqual(row?.kind === "enquiry" ? row.answers : [], [["Neither — something I typed"]]);
    assert.equal(state.asking, undefined, "answered means the composer is unlocked");
  });

  it("clears `asking` on its own terminal snapshot", () => {
    const state = reduceAll(
      transcript(asked, { type: "enquiry", askId: "a1", questions: QUESTIONS, state: "aborted" }).since(0),
    );
    assert.equal(state.asking, undefined);
  });

  /*
   * The safety valve, and the most important assertion in this block.
   *
   * A torn turn that left `asking` set would lock the composer with no key that unlocks it — the one
   * failure of this feature a human could not recover from without reloading the page. So everything
   * that ends a turn or a Backend Session clears it, not only the Enquiry's own terminal snapshot.
   */
  for (const closing of [
    { type: "turn_ended", turnId: "t1", reason: "aborted" },
    { type: "session_dormant", reason: "host shutdown" },
    { type: "session_settled" },
    { type: "session_ended", reason: "disposed" },
  ] as AgentEvent[]) {
    it(`clears \`asking\` on ${closing.type}, even with no terminal snapshot`, () => {
      const state = reduceAll(transcript({ type: "turn_started", turnId: "t1" }, asked, closing).since(0));
      assert.equal(state.asking, undefined, "a composer locked out for good is unrecoverable");
    });
  }
});

describe("a Permission Prompt", () => {
  /** A call raised and awaiting authorisation, as a real adapter produces it: the row, then the prompt. */
  function raised(callId: string, tool: string, input: unknown = {}): AgentEvent[] {
    return [
      { type: "tool_started", callId, name: tool, input },
      { type: "permission", callId, tool, state: "asked" },
    ];
  }

  it("folds onto the tool row rather than adding one of its own", () => {
    const state = reduceAll(
      transcript(
        { type: "turn_started", turnId: "t1" },
        ...raised("c1", "WebFetch", { url: "https://example.com" }),
        { type: "permission", callId: "c1", tool: "WebFetch", state: "decided", decision: "allow" },
        { type: "tool_ended", callId: "c1", result: "ok", isError: false },
      ).since(0),
    );

    /*
     * The shape of this whole feature in the reducer. A prompt is *about* a call and shares its id,
     * and the row a reader needs is the one already naming the tool and precising its arguments — a
     * second row would print `WebFetch https://…` and then `Permission: allowed` underneath it.
     */
    const rows = state.entries.filter((entry) => entry.kind === "tool");
    assert.equal(rows.length, 1, "one call, one row");
    assert.equal(rows[0]?.kind === "tool" ? rows[0].authorisation : undefined, "allowed");
    // The two readings are independent: `status` stays what the call did.
    assert.equal(rows[0]?.kind === "tool" ? rows[0].status : undefined, "complete");
  });

  it("leaves the authorisation absent on a call nobody was asked about", () => {
    const state = reduceAll(transcript(...SAMPLE).since(0));
    const tool = state.entries.find((entry) => entry.kind === "tool");

    // The common case by far, and it must not read as a decision: most rows in most transcripts are
    // pre-approved or carry a Standing Authorisation, and nobody was ever asked.
    assert.equal(tool?.kind === "tool" ? tool.authorisation : "set", undefined);
  });

  it("keeps always distinct from allowed on the row", () => {
    const state = reduceAll(
      transcript(
        ...raised("c1", "mcp__github__create_pull_request"),
        { type: "permission", callId: "c1", tool: "mcp__github__create_pull_request", state: "decided", decision: "always" },
      ).since(0),
    );
    const tool = state.entries.find((entry) => entry.kind === "tool");

    // The transcript is the only place that ever says which click widened what the machine will run.
    assert.equal(tool?.kind === "tool" ? tool.authorisation : undefined, "always");
  });

  it("records an abandoned prompt as refused", () => {
    const state = reduceAll(
      transcript(...raised("c1", "Bash"), { type: "permission", callId: "c1", tool: "Bash", state: "aborted" }).since(0),
    );
    const tool = state.entries.find((entry) => entry.kind === "tool");

    // An abandoned prompt *is* a refusal, and the model was told so. Anything softer would leave a
    // row saying "waiting" over a session that has gone.
    assert.equal(tool?.kind === "tool" ? tool.authorisation : undefined, "denied");
  });

  it("holds the same `authorising` reference across repeated snapshots", () => {
    // The property the web chrome rests on, exactly as for `asking` above: a repeated `asked` that
    // minted a fresh object would republish the chrome on every streamed token.
    const log = transcript(...raised("c1", "Bash"), { type: "permission", callId: "c1", tool: "Bash", state: "asked" });
    const entries = log.since(0);
    const opened = reduceAll(entries.slice(0, 2));
    const again = reduce(opened, entries[2] as LoggedEvent);

    assert.deepEqual(opened.authorising, { callId: "c1", tool: "Bash" });
    assert.equal(opened.authorising, again.authorising, "the same object, not an equal one");
  });

  it("holds `authorising` undefined rather than empty when nothing is waiting", () => {
    // Not merely tidy: `sameChrome` compares per key with Object.is, so a fresh empty value on each
    // of the clearing paths would republish the chrome for a session that never saw a prompt.
    assert.equal(initialState().authorising, undefined);
    assert.equal(reduceAll(transcript(...SAMPLE).since(0)).authorising, undefined);
  });

  it("decides several open prompts oldest-first", () => {
    /*
     * One assistant message can carry several tool calls, so several prompts can be open at once.
     * They are worked through in the order they were raised, which is the order a human reads them.
     */
    const opened = reduceAll(transcript(...raised("c1", "Bash"), ...raised("c2", "WebFetch")).since(0));
    assert.deepEqual(opened.authorising, { callId: "c1", tool: "Bash" }, "the oldest is in hand");

    const decided = reduce(
      opened,
      transcript({ type: "permission", callId: "c1", tool: "Bash", state: "decided", decision: "allow" }).since(0)[0] as LoggedEvent,
    );
    assert.deepEqual(decided.authorising, { callId: "c2", tool: "WebFetch" }, "deciding one promotes the next");
  });

  it("clears `authorising` when the last open prompt is decided", () => {
    const state = reduceAll(
      transcript(
        ...raised("c1", "Bash"),
        { type: "permission", callId: "c1", tool: "Bash", state: "decided", decision: "deny" },
      ).since(0),
    );
    assert.equal(state.authorising, undefined);
  });

  /*
   * The lockout's escape hatches. While `authorising` is set the composer may only decide, so a torn
   * turn that left it set would lock it with no key that unlocks it — the one failure of this feature
   * a human could not recover from without reloading.
   */
  const CLEARING: Array<[string, AgentEvent]> = [
    ["turn_ended", { type: "turn_ended", turnId: "t1", reason: "aborted" }],
    ["session_dormant", { type: "session_dormant", reason: "host shutdown" }],
    ["session_settled", { type: "session_settled" }],
    ["session_ended", { type: "session_ended", reason: "disposed" }],
  ];

  for (const [name, event] of CLEARING) {
    it(`clears \`authorising\` on ${name}`, () => {
      const state = reduceAll(transcript({ type: "turn_started", turnId: "t1" }, ...raised("c1", "Bash"), event).since(0));
      assert.equal(state.authorising, undefined);
    });
  }

  /**
   * The reducer derives `status` through the same `deriveStatus` the Session Host calls, so these
   * are as much about the two agreeing as about the reducer itself.
   */
  describe("deriving what the Agent Session is doing", () => {
    it("reports awaiting while a Permission Prompt is open, and running once it is decided", () => {
      const asked = reduceAll(
        transcript(
          { type: "turn_started", turnId: "t1" },
          { type: "tool_started", callId: "c1", name: "Bash", input: {} },
          { type: "permission", callId: "c1", tool: "Bash", state: "asked" },
        ).since(0),
      );
      assert.equal(asked.status, "awaiting");

      const decided = reduceAll(
        transcript({ type: "permission", callId: "c1", tool: "Bash", state: "decided", decision: "allow" }).since(0),
        asked,
      );
      assert.equal(decided.status, "running", "the model has the turn back");

      const ended = reduceAll(transcript({ type: "turn_ended", turnId: "t1", reason: "complete" }).since(0), decided);
      assert.equal(ended.status, "idle");
    });

    it("reports awaiting while an Enquiry is open", () => {
      const state = reduceAll(
        transcript(
          { type: "turn_started", turnId: "t1" },
          { type: "tool_started", callId: "c1", name: "AskUserQuestion", input: {} },
          {
            type: "enquiry",
            askId: "c1",
            questions: [{ header: "Pick", question: "Which?", multiSelect: false, options: [{ label: "a" }] }],
            state: "asked",
          },
        ).since(0),
      );
      assert.equal(state.status, "awaiting");
    });

    it("lets the Lifecycle beat an Enquiry nothing closed", () => {
      // Going Dormant clears `asking`, so a torn Enquiry cannot leave a Dormant Agent Session
      // reporting that it is waiting on a person who has no way to answer.
      const state = reduceAll(
        transcript(
          { type: "turn_started", turnId: "t1" },
          { type: "tool_started", callId: "c1", name: "AskUserQuestion", input: {} },
          {
            type: "enquiry",
            askId: "c1",
            questions: [{ header: "Pick", question: "Which?", multiSelect: false, options: [{ label: "a" }] }],
            state: "asked",
          },
          { type: "session_dormant", reason: "host restarted" },
        ).since(0),
      );
      assert.equal(state.status, "dormant");
    });

    it("leaves a backgrounded Subagent out of the status and in the count", () => {
      // ADR 0016: the model is idle and the Steering Queue may dispatch, so the status says idle.
      const state = reduceAll(
        transcript(
          { type: "turn_started", turnId: "t1" },
          { type: "subagent", subagentId: "s1", name: "Explore", state: "running" },
          { type: "turn_ended", turnId: "t1", reason: "complete" },
        ).since(0),
      );
      assert.equal(state.status, "idle");
      assert.equal(state.activeSubagents, 1);
    });
  });
});
