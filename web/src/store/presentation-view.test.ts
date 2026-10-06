import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PresentationSubscribeOptions } from "../../../src/client/connection.ts";
import type { LoggedEvent } from "../../../src/protocol/events.ts";
import { initialState, type Entry } from "../../../src/client/reduce.ts";
import type { PresentationPage, PresentationSnapshot, PresentationState } from "../../../src/protocol/presentation.ts";
import { createAgentSessionView, type TranscriptTransport } from "./agent-session-view.ts";
import { SessionLog } from "../../../src/daemon/log.ts";
import { ownKeys } from "../presentation/subagent-rows.ts";

const message = (id: string, text = id): Entry => ({ kind: "assistant", id, text, final: true });
function metadata(): PresentationState {
  const { entries: _entries, lastSeq: _seq, ...state } = initialState();
  return state;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let subscription!: PresentationSubscribeOptions;
  const frames: Array<() => void> = [];
  const requests: Array<{ before: number; signal: AbortSignal | undefined; result: ReturnType<typeof deferred<PresentationPage>> }> = [];
  let rawStarts = 0;
  const transport: TranscriptTransport = {
    subscribe() { rawStarts++; throw new Error("must not replay raw history"); },
    subscribePresentation(options) { subscription = options; return () => {}; },
    readPresentation(_id, before, signal) {
      const result = deferred<PresentationPage>();
      requests.push({ before, signal, result });
      return result.promise;
    },
  };
  const view = createAgentSessionView("s1", transport, { schedule: task => frames.push(task) });
  view.start();
  const snapshot = (overrides: Partial<PresentationSnapshot> = {}) => {
    subscription.onSnapshot({
      type: "snapshot", seq: 100, state: metadata(), total: 10, start: 8,
      entries: [{ index: 8, entry: message("eight") }, { index: 9, entry: message("nine") }], related: [], ...overrides,
    });
    subscription.onLink?.("live");
  };
  return { view, requests, snapshot, subscription: () => subscription, rawStarts: () => rawStarts, flush: () => { for (const frame of frames.splice(0)) frame(); } };
}

/** Exercise both live server patches and live raw replay against the same boundaries. */
function liveViews(log: SessionLog) {
  const h = harness(); h.snapshot(log.presentationSnapshot());
  log.subscribePresentation(update => h.subscription().onUpdate(update));
  let rawEntry!: (entry: LoggedEvent) => void;
  const raw = createAgentSessionView("s1", {
    subscribe(options) {
      rawEntry = options.onEntry;
      for (const entry of log.since(0)) rawEntry(entry);
      return () => {};
    },
  }, { schedule: task => task() });
  raw.start();
  log.subscribe(entry => rawEntry(entry));
  return { h, views: [h.view, raw] };
}

describe("tail-first Presentation Transcript view", () => {
  it("cannot observe an unseen answer after its row is reused, before the new turn ends", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "A" });
    log.append({ type: "message", id: "x", text: "old unseen", final: true });
    const old = log.append({ type: "turn_ended", turnId: "A", reason: "complete" });
    assert.equal(old.seq, 3);
    const { views } = liveViews(log);
    for (const view of views) assert.equal(view.canObserveThrough(3, ["assistant:x"]), true);
    log.append({ type: "turn_started", turnId: "B" });
    log.append({ type: "message", id: "x", text: "new partial", final: false });
    for (const view of views) assert.equal(view.canObserveThrough(3, ["assistant:x"]), false);
    const end = log.append({ type: "turn_ended", turnId: "B", reason: "complete" });
    for (const view of views) assert.equal(view.canObserveThrough(end.seq, ["assistant:x"]), true);
  });

  it("cannot observe superseded independent failures or reopened input through either transport", () => {
    for (const kind of ["subagent", "background_call"] as const) {
      const log = new SessionLog("s1");
      const append = (state: "running" | "error") => log.append(kind === "subagent"
        ? { type: kind, subagentId: "x", name: "reviewer", state }
        : { type: kind, callId: "x", tool: "Bash", state });
      append("running");
      const failed = append("error");
      assert.equal(failed.seq, 2);
      const { views } = liveViews(log);
      append("error");
      for (const view of views) assert.equal(view.canObserveThrough(2, [`${kind}:x`]), true);
      append("running");
      for (const view of views) assert.equal(view.canObserveThrough(2, [`${kind}:x`]), false);
    }
    for (const restart of ["tool", "enquiry"] as const) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "A" });
      log.append({ type: "tool_started", callId: "x", name: "Ask", input: {} });
      log.append({ type: "enquiry", askId: "x", state: "answered", questions: [], answers: [["yes"]] });
      log.append({ type: "tool_ended", callId: "x", result: "yes", isError: false });
      const end = log.append({ type: "turn_ended", turnId: "A", reason: "complete" });
      const { views } = liveViews(log);
      for (const view of views) assert.equal(view.canObserveThrough(end.seq, ["enquiry:x"]), true);
      log.append({ type: "turn_started", turnId: "B" });
      log.append(restart === "tool"
        ? { type: "tool_started", callId: "x", name: "Ask", input: {} }
        : { type: "enquiry", askId: "x", state: "asked", questions: [] });
      for (const view of views) assert.equal(view.canObserveThrough(end.seq, ["tool:x", "enquiry:x"]), false);
    }
  });

  it("observes the previous valid parent answer after the latest candidate becomes producer output", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "parent" });
    log.append({ type: "message", id: "a", text: "parent answer", final: true });
    log.append({ type: "message", id: "b", text: "later answer", final: true });
    const { views } = liveViews(log);
    log.append({ type: "message", id: "b", text: "child answer", final: true, producer: { subagentId: "sub" } });
    const end = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" });
    for (const view of views) {
      assert.equal(view.canObserveThrough(end.seq, ["assistant:a"]), true);
      assert.equal(view.canObserveThrough(end.seq, ["assistant:b"]), false);
    }
  });

  it("requires the hidden tool-only parent result, not its visible independent Workflow notice", async () => {
    for (const text of ["Workflow completed. The parent will prepare the result when free.", "Workflow requires recovery. The parent will inspect it when free."]) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "parent" });
      log.append({ type: "tool_started", callId: "result", name: "Read", input: {} });
      log.append({ type: "tool_ended", callId: "result", result: "parent result", isError: false });
      for (let i = 0; i < 400; i++) log.append({ type: "message", id: `child-${i}`, text: "child", final: true, producer: { subagentId: "sub" } });
      const notice = log.append({ type: "notice", level: "info", text });
      const { h, views } = liveViews(log);
      const end = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" });
      const key = `notice:notice-401`;
      for (const view of views) {
        assert.equal(view.canObserveThrough(notice.seq, [key]), true);
        assert.equal(view.canObserveThrough(end.seq, [key]), false);
      }
      assert.equal(h.view.canObserveThrough(end.seq, h.view.getKeys()), false);
      const loading = h.view.loadOlder();
      h.requests[0]!.result.resolve(log.presentationPage(h.requests[0]!.before));
      await loading;
      for (const view of views) assert.equal(view.canObserveThrough(end.seq, ["tool:result"]), true);
    }
  });
  it("does not observe a parent answer hidden behind 450 Subagent rows, until explicitly loaded and rendered", async () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "parent" });
    log.append({ type: "message", id: "answer", text: "Parent answer", final: true });
    const outcome = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" });
    for (let i = 0; i < 450; i++) {
      log.append({ type: "message", id: `sub-${i}`, text: "Delegated output", final: true, producer: { subagentId: "agent" } });
    }
    const h = harness(); h.snapshot(log.presentationSnapshot());
    const shown = () => ownKeys(h.view.getKeys(), key => h.view.getEntry(key));
    assert.equal(h.view.getKeys().length, 400);
    assert.deepEqual(shown(), []);
    assert.ok(h.view.getLastSeq() >= outcome.seq, "transport delivery alone used to allow acknowledgement");
    assert.equal(h.view.canObserveThrough(outcome.seq, shown()), false);
    assert.equal(h.requests.length, 0, "observation must not fetch history eagerly");

    const loading = h.view.loadOlder();
    h.requests[0]!.result.resolve(log.presentationPage(h.requests[0]!.before));
    await loading;
    assert.deepEqual(shown(), ["assistant:answer"]);
    assert.equal(h.view.canObserveThrough(outcome.seq, []), false, "loaded is not rendered");
    assert.equal(h.view.canObserveThrough(outcome.seq, shown()), true);
  });

  it("keeps hidden live upserts and proof-only turn endings hidden until paged and rendered", async () => {
    const log = new SessionLog("s1");
    log.append({ type: "message", id: "old-answer", text: "old", final: true });
    for (let i = 0; i < 450; i++) log.append({ type: "message", id: `other-${i}`, text: "older", final: true });
    const h = harness(); h.snapshot(log.presentationSnapshot());
    log.subscribePresentation(update => h.subscription().onUpdate(update));
    log.append({ type: "turn_started", turnId: "next" });
    log.append({ type: "message", id: "old-answer", text: "new outcome", final: true });
    const outcome = log.append({ type: "turn_ended", turnId: "next", reason: "complete" });
    assert.equal(h.view.canObserveThrough(outcome.seq, h.view.getKeys()), false);
    assert.equal(h.view.getKeys().includes("assistant:old-answer"), false);
    const loading = h.view.loadOlder();
    h.requests[0]!.result.resolve(log.presentationPage(h.requests[0]!.before));
    await loading;
    assert.equal(h.view.canObserveThrough(outcome.seq, []), false);
    assert.equal(h.view.canObserveThrough(outcome.seq, ["assistant:old-answer"]), true);
    assert.equal(h.view.canObserveThrough(outcome.seq + 1, h.view.getKeys()), false, "cannot observe an undelivered boundary");
  });

  it("requires qualifying independent-work failures to survive the rendered-key filter", () => {
    const h = harness();
    const failed: Entry = { kind: "subagent", id: "nested", name: "Nested", status: "error", startedAt: "2026-10-01T00:00:00Z", producer: { subagentId: "outer" } };
    h.snapshot({ start: 0, total: 2, entries: [{ index: 0, entry: message("answer"), outcomeSeq: 90 }, { index: 1, entry: failed, outcomeSeq: 100 }] });
    const shown = ownKeys(h.view.getKeys(), key => h.view.getEntry(key));
    assert.deepEqual(shown, ["assistant:answer"]);
    assert.equal(h.view.canObserveThrough(100, shown), false);
    assert.equal(h.view.canObserveThrough(100, h.view.getKeys()), true);
    h.subscription().onUpdate({ type: "update", seq: 101, total: 3, entries: [{ index: 2, outcomeSeq: 101, entry: { kind: "background_call", id: "failed-call", tool: "Bash", status: "error", startedAt: "2026-10-01T00:00:00Z" } }] });
    assert.equal(h.view.canObserveThrough(101, h.view.getKeys().filter(key => key !== "background_call:failed-call")), false);
    assert.equal(h.view.canObserveThrough(101, ["background_call:failed-call"]), true);
  });

  it("observes the latest visible parent answer in a long tail without loading unrelated older outcomes", () => {
    const log = new SessionLog("s1");
    for (let i = 0; i < 450; i++) {
      log.append({ type: "turn_started", turnId: `t-${i}` });
      log.append({ type: "message", id: `answer-${i}`, text: "answer", final: true });
      log.append({ type: "turn_ended", turnId: `t-${i}`, reason: "complete" });
    }
    const h = harness(); h.snapshot(log.presentationSnapshot());
    assert.equal(h.view.getHistory().earlier, 50);
    assert.equal(h.view.canObserveThrough(log.lastSeq, ["assistant:answer-449"]), true);
    assert.equal(h.view.canObserveThrough(log.lastSeq, ["assistant:answer-448"]), false);
    assert.equal(h.requests.length, 0);
    for (const boundary of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(h.view.canObserveThrough(boundary, h.view.getKeys()), false);
    }
  });

  it("observes a spawning tool outcome through the card that replaces its hidden tool row", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "spawn" });
    log.append({ type: "tool_started", callId: "sub", name: "Agent", input: "review" });
    log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "running" });
    log.append({ type: "tool_ended", callId: "sub", result: "spawned", isError: false });
    const outcome = log.append({ type: "turn_ended", turnId: "spawn", reason: "complete" });
    const h = harness(); h.snapshot(log.presentationSnapshot());
    const shown = ownKeys(h.view.getKeys(), key => h.view.getEntry(key));
    assert.deepEqual(shown, ["subagent:sub"]);
    assert.equal(h.view.canObserveThrough(outcome.seq, shown), true);
    assert.equal(h.view.canObserveThrough(outcome.seq, []), false);
  });

  it("requires exact outcomes, not newer proofs, metadata sequences, or Needs input boundaries", () => {
    const h = harness();
    h.snapshot({ entries: [{ index: 9, entry: message("answer"), outcomeSeq: 95 }] });
    assert.equal(h.view.canObserveThrough(95, ["assistant:answer"]), true);
    assert.equal(h.view.canObserveThrough(94, ["assistant:answer"]), false);
    assert.equal(h.view.canObserveThrough(100, ["assistant:answer"]), false);
    h.subscription().onUpdate({ type: "update", seq: 101, total: 10, entries: [{ index: 9, entry: message("answer", "new answer"), outcomeSeq: 101 }] });
    assert.equal(h.view.canObserveThrough(95, ["assistant:answer"]), false, "a delayed boundary cannot borrow a newer outcome proof");
    assert.equal(h.view.canObserveThrough(101, ["assistant:answer"]), true);
    h.subscription().onUpdate({ type: "update", seq: 102, total: 10, entries: [], state: { ...metadata(), status: "awaiting", turnInFlight: true, authorising: { callId: "ask", tool: "Write" } } });
    assert.equal(h.view.canObserveThrough(102, h.view.getKeys()), false, "Needs input cannot consume underlying unread");
    assert.equal(h.view.canObserveThrough(101, ["assistant:answer"]), true);
  });

  it("versions proofs along with rows and waits for stream delivery even when a page is newer", async () => {
    const h = harness(); h.snapshot();
    const loading = h.view.loadOlder();
    h.subscription().onUpdate({ type: "update", seq: 101, total: 10, entries: [{ index: 7, entry: message("seven"), outcomeSeq: 101 }] });
    h.requests[0]!.result.resolve({ seq: 100, start: 7, total: 10, entries: [{ index: 7, entry: message("seven", "stale"), outcomeSeq: 90 }] });
    await loading;
    assert.equal(h.view.canObserveThrough(101, ["assistant:seven"]), true);
    assert.equal(h.view.canObserveThrough(90, ["assistant:seven"]), false, "an older page must not restore obsolete proof");
    const next = h.view.loadOlder();
    h.requests[1]!.result.resolve({ seq: 103, start: 6, total: 10, entries: [{ index: 6, entry: message("six"), outcomeSeq: 103 }] });
    await next;
    assert.equal(h.view.canObserveThrough(103, ["assistant:six"]), false, "pages do not advance the stream boundary");
    h.subscription().onUpdate({ type: "update", seq: 102, total: 10, entries: [{ index: 6, entry: message("six", "stale live"), outcomeSeq: 102 }] });
    h.subscription().onUpdate({ type: "update", seq: 103, total: 10, entries: [] });
    assert.equal(h.view.canObserveThrough(103, ["assistant:six"]), true);
    assert.equal(h.view.canObserveThrough(102, ["assistant:six"]), false);
  });

  it("derives equivalent proof on raw replay without treating producer messages as the parent result", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "parent" });
    log.append({ type: "message", id: "parent", text: "answer", final: true });
    log.append({ type: "message", id: "child", text: "delegated", final: true, producer: { subagentId: "sub" } });
    const end = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" });
    const view = createAgentSessionView("s1", {
      subscribe(options) { for (const entry of log.since(0)) options.onEntry(entry); return () => {}; },
    }, { schedule: task => task() });
    view.start();
    assert.equal(view.canObserveThrough(end.seq, ["assistant:child"]), false);
    assert.equal(view.canObserveThrough(end.seq, ["assistant:parent"]), true);
    assert.equal(view.canObserveThrough(end.seq - 1, view.getKeys()), false);
  });

  it("publishes current chrome and only the tail, without any historical Running replay", () => {
    const h = harness();
    assert.equal(h.view.getHistory().loading, true);
    const statuses: string[] = [];
    h.view.subscribeChrome(() => statuses.push(h.view.getChrome().status));
    h.snapshot({ state: { ...metadata(), backend: "fake", status: "idle", spoken: true } });
    h.subscription().onLink?.("live");
    h.flush();
    assert.deepEqual(statuses, ["idle"]);
    assert.equal(h.rawStarts(), 0);
    assert.deepEqual(h.view.getKeys(), ["assistant:eight", "assistant:nine"]);
    assert.equal(h.view.getLastSeq(), 100);
    assert.deepEqual(h.view.getHistory(), { earlier: 8, loading: false, loadingOlder: false, error: undefined });
    assert.equal(h.subscription().start(), 8);
  });

  it("preserves keys and untouched rows while a live snapshot grows", () => {
    const h = harness(); h.snapshot(); h.flush();
    const keys = h.view.getKeys();
    const eight = h.view.getEntry("assistant:eight");
    let chromeUpdates = 0;
    h.view.subscribeChrome(() => chromeUpdates++);
    h.subscription().onUpdate({ type: "update", seq: 101, total: 10, entries: [{ index: 9, entry: message("nine", "growing") }] });
    h.flush();
    assert.equal(h.view.getKeys(), keys);
    assert.equal(h.view.getEntry("assistant:eight"), eight);
    assert.equal((h.view.getEntry("assistant:nine") as Extract<Entry, { kind: "assistant" }>).text, "growing");
    assert.equal(chromeUpdates, 0);
    assert.equal(h.view.getLastSeq(), 101);
  });

  it("offers measurements before any reactive subscriber can commit a page prepend", async () => {
    const h = harness(); h.snapshot(); h.flush();
    const order: string[] = [];
    h.view.subscribeChrome(() => order.push("chrome"));
    h.view.subscribeTranscript(() => order.push("transcript"));
    const stop = h.view.subscribeBeforeTranscript(earlier => {
      order.push(`before:${h.view.getHistory().earlier}${earlier === undefined ? "" : `->${earlier}`}`);
      if (earlier !== undefined) assert.ok(!h.view.getKeys().includes("assistant:seven"), "prefix is not exposed before measurement");
    });
    const loading = h.view.loadOlder(); h.flush(); order.length = 0;
    h.requests[0]!.result.resolve({ seq: 100, start: 7, total: 10, entries: [{ index: 7, entry: message("seven") }] });
    await loading;
    assert.deepEqual(order, ["before:8->7"], "measure synchronously before unrelated React work can read the new prefix");
    h.subscription().onUpdate({ type: "update", seq: 101, total: 10, entries: [], state: { ...metadata(), status: "running", turnInFlight: true } });
    h.flush();
    assert.deepEqual(order, ["before:8->7", "before:7", "chrome", "transcript"]);
    stop(); order.length = 0;
    h.subscription().onUpdate({ type: "update", seq: 102, total: 10, entries: [] }); h.flush();
    assert.deepEqual(order, ["transcript"]);
  });

  it("shares backward requests and prepends in ordinal order without changing current activity", async () => {
    const h = harness(); h.snapshot({ state: { ...metadata(), status: "running", turnInFlight: true } });
    const first = h.view.loadOlder();
    assert.equal(h.view.loadOlder(), first);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]!.before, 8);
    assert.equal(h.view.getHistory().loadingOlder, true);
    h.requests[0]!.result.resolve({ seq: 100, start: 6, total: 10, entries: [{ index: 6, entry: message("six") }, { index: 7, entry: message("seven") }] });
    await first; h.flush();
    assert.deepEqual(h.view.getKeys(), ["assistant:six", "assistant:seven", "assistant:eight", "assistant:nine"]);
    assert.equal(h.view.getChrome().status, "running");
    assert.equal(h.view.getLastSeq(), 100);
    assert.equal(h.subscription().start(), 6);
    assert.equal(h.view.getHistory().earlier, 6);
  });

  it("does not let a slow older page overwrite a newer patch to an unloaded row", async () => {
    const h = harness(); h.snapshot();
    const loading = h.view.loadOlder();
    h.subscription().onUpdate({ type: "update", seq: 101, total: 10, entries: [{ index: 7, entry: message("seven", "new version") }] });
    assert.deepEqual(h.view.getKeys(), ["assistant:eight", "assistant:nine"], "a hidden old row must not append at the tail");
    h.requests[0]!.result.resolve({ seq: 100, start: 7, total: 10, entries: [{ index: 7, entry: message("seven", "stale page") }] });
    await loading;
    assert.equal((h.view.getEntry("assistant:seven") as Extract<Entry, { kind: "assistant" }>).text, "new version");
    assert.deepEqual(h.view.getKeys(), ["assistant:seven", "assistant:eight", "assistant:nine"]);
    assert.equal(h.view.getLastSeq(), 101);
  });

  it("retains off-tail activity cards and Permission Prompt inputs without putting them in the main transcript", () => {
    const h = harness();
    const tool: Entry = { kind: "tool", id: "old-tool", name: "bash", input: { command: "pwd" }, status: "running", authorisation: "asked" };
    const agent: Entry = { kind: "subagent", id: "agent", name: "Reviewer", status: "running", startedAt: "2026-10-01T00:00:00Z" };
    h.snapshot({ related: [{ index: 1, entry: tool }, { index: 2, entry: agent }], state: { ...metadata(), status: "awaiting", turnInFlight: true, authorising: { callId: "old-tool", tool: "bash" }, activeSubagents: 1 } });
    assert.deepEqual(h.view.getKeys(), ["assistant:eight", "assistant:nine"]);
    assert.deepEqual(h.view.getActivityKeys(), ["tool:old-tool", "subagent:agent", "assistant:eight", "assistant:nine"]);
    assert.equal(h.view.getEntry("tool:old-tool"), tool);
    assert.equal(h.view.getChrome().status, "awaiting");
    h.subscription().onUpdate({ type: "update", seq: 101, total: 10, state: { ...metadata(), activeSubagents: 0 }, entries: [{ index: 2, entry: { ...agent, status: "complete" } }] });
    assert.equal((h.view.getEntry("subagent:agent") as Extract<Entry, { kind: "subagent" }>).status, "complete");
    assert.equal(h.view.getChrome().activeSubagents, 0);
  });

  it("refreshes loaded history on reconnect and cancels pages from the previous connection", async () => {
    const h = harness(); h.snapshot();
    const loading = h.view.loadOlder();
    h.subscription().onLink?.("connecting");
    assert.equal(h.requests[0]!.signal?.aborted, true);
    await h.view.loadOlder();
    assert.equal(h.requests.length, 1, "pagination must wait for the fresh snapshot");
    h.snapshot({ seq: 200, entries: [{ index: 8, entry: message("eight", "fresh") }, { index: 9, entry: message("nine") }] });
    h.requests[0]!.result.resolve({ seq: 100, start: 0, total: 10, entries: [{ index: 0, entry: message("discarded") }] });
    await loading;
    assert.equal(h.view.getEntry("assistant:discarded"), undefined);
    assert.equal(h.view.getHistory().earlier, 8);
    assert.equal(h.view.getLastSeq(), 200);
  });

  it("reports initial failures and offers a retry for older-page errors without losing current content", async () => {
    const h = harness(); h.snapshot();
    const loading = h.view.loadOlder();
    h.requests[0]!.result.reject(new Error("offline"));
    await loading;
    assert.equal(h.view.getHistory().error, "offline");
    assert.equal(h.view.getHistory().loadingOlder, false);
    assert.deepEqual(h.view.getKeys(), ["assistant:eight", "assistant:nine"]);
    const retry = h.view.loadOlder();
    h.requests[1]!.result.resolve({ seq: 100, start: 0, total: 10, entries: Array.from({ length: 8 }, (_, index) => ({ index, entry: message(`older-${index}`) })) });
    await retry;
    assert.equal(h.view.getHistory().error, undefined);
    assert.equal(h.view.getHistory().earlier, 0);
    assert.equal(h.view.getKeys().length, 10);

    const opening = harness();
    opening.subscription().onLink?.("gone");
    opening.subscription().onError?.(new Error("Transcript unavailable"));
    assert.equal(opening.view.getHistory().loading, false);
    assert.equal(opening.view.getHistory().error, "Transcript unavailable");
    assert.deepEqual(opening.view.getKeys(), []);
  });

  it("ignores duplicate updates and retains server-generated marker identities", () => {
    const h = harness();
    h.snapshot({ entries: [{ index: 8, entry: { kind: "marker", id: "settled-2500", marker: "settled", text: "Settled" } }] });
    h.subscription().onUpdate({ type: "update", seq: 100, total: 10, entries: [{ index: 8, entry: message("duplicate") }] });
    assert.deepEqual(h.view.getKeys(), ["marker:settled-2500"]);
    assert.equal(h.view.getLastSeq(), 100);
    assert.equal(h.view.getEntry("assistant:duplicate"), undefined);
  });
});
