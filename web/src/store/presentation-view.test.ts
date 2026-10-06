import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PresentationSubscribeOptions } from "../../../src/client/connection.ts";
import { initialState, type Entry } from "../../../src/client/reduce.ts";
import type { PresentationPage, PresentationSnapshot, PresentationState } from "../../../src/protocol/presentation.ts";
import { createAgentSessionView, type TranscriptTransport } from "./agent-session-view.ts";

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

describe("tail-first Presentation Transcript view", () => {
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
