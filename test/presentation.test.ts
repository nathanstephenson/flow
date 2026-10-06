import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { reduceAll, type ViewState } from "../src/client/reduce.ts";
import type { OidcGate } from "../src/daemon/auth.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { SessionLog } from "../src/daemon/log.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import type { AgentEvent, LoggedEvent } from "../src/protocol/events.ts";
import type { PresentationPage, PresentationSnapshot, PresentationState, PresentationUpdate } from "../src/protocol/presentation.ts";

const CAPS = { providers: ["fake"], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false };
const AT = "2026-01-01T00:00:00.000Z";

function metadata({ entries: _entries, lastSeq: _lastSeq, ...state }: ViewState): PresentationState {
  return state;
}

/** Thousands of raw snapshots, but only 450 reduced rows. */
function fill(log: SessionLog, count = 450): void {
  for (let index = 0; index < count; index++) {
    for (let snapshot = 0; snapshot < 4; snapshot++) {
      log.append({ type: "message", id: `m-${index}`, text: `row ${index}, snapshot ${snapshot}`, final: snapshot === 3 }, AT);
    }
  }
}

function populated(): SessionLog {
  const log = new SessionLog("s1");
  log.append({ type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS }, AT);
  log.append({ type: "user_message", id: "u", text: "hello" }, AT);
  log.append({ type: "tool_started", callId: "tool", name: "Read", input: { path: "x" } }, AT);
  log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "running" }, AT);
  log.append({ type: "background_call", callId: "bg", tool: "Bash", state: "complete" }, AT);
  log.append({ type: "tool_started", callId: "permission", name: "Write", input: "x" }, AT);
  log.append({ type: "permission", callId: "permission", tool: "Write", state: "asked" }, AT);
  log.append({ type: "enquiry", askId: "ask", state: "asked", questions: [] }, AT);
  log.append({ type: "notice", level: "info", text: "old notice" }, AT);
  log.append({ type: "compacted", trigger: "auto", before: 1000, after: 100 }, AT);
  fill(log);
  log.append({ type: "notice", level: "info", text: "recent notice" }, AT);
  log.append({ type: "session_dormant", reason: "restart" }, AT);
  log.append({ type: "revived", fromSeq: log.lastSeq }, AT);
  log.append({ type: "turn_started", turnId: "turn" }, AT);
  return log;
}

describe("reduced Presentation Transcript", () => {
  it("lazily reduces once, then maintains the cache before notifying raw subscribers", () => {
    let reads = 0;
    const existing: LoggedEvent = {
      sessionId: "lazy", seq: 1, at: AT,
      get event(): AgentEvent { reads++; return { type: "notice", level: "info", text: "stored" }; },
    };
    const log = new SessionLog("lazy", { existing: [existing] });
    log.append({ type: "notice", level: "info", text: "unviewed" }, AT);
    assert.equal(reads, 0);
    const first = log.presentationSnapshot();
    assert.equal(reads, 1);
    const second = log.presentationSnapshot();
    assert.strictEqual(first.entries[0]?.entry, second.entries[0]?.entry);
    assert.equal(reads, 1);
    const stop = log.subscribe(() => {
      assert.equal(log.presentationPage().total, 3);
      assert.equal(log.presentationPage().seq, 3);
    });
    log.append({ type: "notice", level: "info", text: "viewed" }, AT);
    stop();
    assert.equal(reads, 1, "appending never replays old events");
  });

  it("tails reduced entries, paginates ordinals, and preserves full-replay marker IDs", () => {
    const log = populated();
    const full = reduceAll(log.since(0));
    const tail = log.presentationSnapshot();
    assert.equal(tail.entries.length, 400);
    assert.equal(tail.total, full.entries.length);
    assert.equal(tail.start, full.entries.length - 400);
    assert.equal(tail.seq, log.lastSeq);
    assert.deepEqual(tail.state, metadata(full));
    assert.deepEqual(tail.entries.map(item => item.entry), full.entries.slice(tail.start));
    assert.deepEqual(tail.entries.map(item => item.index), Array.from({ length: 400 }, (_, i) => i + tail.start));
    assert.deepEqual(tail.entries.filter(item => item.entry.kind === "marker").map(item => item.entry.id),
      full.entries.slice(tail.start).filter(item => item.kind === "marker").map(item => item.id));

    let before = tail.start;
    let older = [] as PresentationPage["entries"];
    while (before > 0) {
      const page = log.presentationPage(before, 17);
      assert.equal(page.seq, log.lastSeq);
      assert.equal(page.entries.at(-1)?.index, before - 1);
      older = [...page.entries, ...older];
      before = page.start;
    }
    assert.deepEqual([...older, ...tail.entries].map(item => item.entry), full.entries);
    assert.deepEqual(log.presentationPage(0).entries, []);
    assert.deepEqual(log.presentationPage().entries, tail.entries);
    assert.deepEqual(log.presentationSnapshot(0).entries.map(item => item.entry), full.entries);
    assert.equal(log.presentationSnapshot(tail.start - 20, 1).entries.length, 420, "reconnect limit does not truncate loaded suffix");
    assert.equal(log.presentationSnapshot(undefined, 12).entries.length, 12);
    assert.equal(log.presentationSnapshot(full.entries.length).entries.length, 0);
  });

  it("publishes exact full-log Idle, Running and Awaiting state, not replay chrome", () => {
    const log = populated();
    const check = (status: PresentationState["status"]) => {
      const snapshot = log.presentationSnapshot(undefined, 1);
      assert.deepEqual(snapshot.state, metadata(reduceAll(log.since(0))));
      assert.equal(snapshot.state.status, status);
      assert.ok(!("entries" in snapshot.state));
      assert.ok(!("lastSeq" in snapshot.state));
    };
    check("running");
    log.append({ type: "turn_ended", turnId: "turn", reason: "complete" }, AT);
    check("idle");
    log.append({ type: "turn_started", turnId: "next" }, AT);
    log.append({ type: "permission", callId: "tool", tool: "Read", state: "asked" }, AT);
    check("awaiting");
    assert.equal(log.presentationSnapshot().state.authorising?.callId, "tool");
    log.append({ type: "permission", callId: "tool", tool: "Read", state: "decided", decision: "allow" }, AT);
    log.append({ type: "enquiry", askId: "next-ask", state: "asked", questions: [] }, AT);
    check("awaiting");
    assert.equal(log.presentationSnapshot().state.asking?.askId, "next-ask");
  });

  it("includes every outside card and unresolved control, without duplicating suffix rows", () => {
    const log = populated();
    // Dormant clears the active prompt but old asked rows still belong in related.
    let snapshot = log.presentationSnapshot();
    assert.deepEqual(snapshot.related.map(item => item.entry.id), ["sub", "bg", "permission", "ask"]);
    assert.ok(snapshot.related.every(item => item.index < snapshot.start));
    log.append({ type: "permission", callId: "tool", tool: "Read", state: "asked" }, AT);
    // A repeated tool-start drops authorisation on the row, but chrome still addresses it.
    log.append({ type: "tool_started", callId: "tool", name: "Read", input: "again" }, AT);
    snapshot = log.presentationSnapshot();
    assert.equal(snapshot.state.authorising?.callId, "tool");
    assert.deepEqual(snapshot.related.map(item => item.entry.id), ["tool", "sub", "bg", "permission", "ask"]);
    log.append({ type: "subagent", subagentId: "recent", name: "new", state: "running" }, AT);
    snapshot = log.presentationSnapshot();
    assert.equal(snapshot.entries.at(-1)?.entry.id, "recent");
    assert.ok(!snapshot.related.some(item => item.entry.id === "recent"));
    assert.deepEqual(log.presentationSnapshot(0).related, []);
  });

  it("diffs identities at old ordinals and sends metadata only on shallow changes", () => {
    const log = populated();
    const snapshot = log.presentationSnapshot();
    const updates: PresentationUpdate[] = [];
    const stop = log.subscribePresentation(update => updates.push(update));
    log.append({ type: "tool_updated", callId: "tool", update: "late" }, AT);
    let update = updates.at(-1)!;
    assert.equal(update.entries[0]?.index, 1);
    assert.equal(update.entries[0]?.entry.id, "tool");
    assert.ok(!("state" in update));
    log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "complete" }, AT);
    update = updates.at(-1)!;
    assert.equal(update.entries[0]?.index, 2);
    assert.equal(update.state?.activeSubagents, 0);
    assert.deepEqual(update.state, metadata(reduceAll(log.since(0))));
    log.append({ type: "message", id: "m-449", text: "late text", final: true }, AT);
    update = updates.at(-1)!;
    assert.equal(update.entries.length, 1);
    assert.equal(update.entries[0]?.index, snapshot.entries.find(item => item.entry.id === "m-449")?.index);
    assert.ok(!("state" in update), "ordinary streaming cannot republish chrome");
    log.append({ type: "message", id: "new", text: "new text", final: false }, AT);
    update = updates.at(-1)!;
    assert.equal(update.total, snapshot.total + 1);
    assert.equal(update.entries[0]?.index, snapshot.total);
    assert.ok(!("state" in update));
    log.append({ type: "queue_changed", pending: ["queued"] }, AT);
    update = updates.at(-1)!;
    assert.deepEqual(update.entries, []);
    assert.deepEqual(update.state?.queue, ["queued"]);
    log.append({ type: "compacting", active: true }, AT);
    assert.equal(updates.at(-1)?.state?.compacting, true);
    log.append({ type: "compacting", active: false }, AT);
    assert.ok(updates.at(-1)?.state && !("compacting" in updates.at(-1)!.state!));
    log.append({ type: "tool_updated", callId: "missing", update: "ignored" }, AT);
    update = updates.at(-1)!;
    assert.equal(update.seq, log.lastSeq, "seq advances even when reducer returns the same state");
    assert.deepEqual(update.entries, []);
    assert.ok(!("state" in update));
    stop();
    const count = updates.length;
    log.append({ type: "notice", text: "unsubscribed", level: "info" }, AT);
    assert.equal(updates.length, count);
    const clear = log.subscribePresentation(update => updates.push(update));
    log.closeSubscribers();
    log.append({ type: "notice", text: "reaped", level: "info" }, AT);
    assert.equal(updates.length, count);
    clear();
  });
});

/** Tiny transport-only SSE reader: no dependency on the client connection under development. */
function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    async next<T>(): Promise<T> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6)) as T;
        } else {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "stream ended before the next frame");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
  };
}

describe("presentation HTTP transport", () => {
  let host: SessionHost;
  let running: RunningServer;
  let id: string;
  let log: SessionLog;
  const token = "presentation-test-token";
  const aborters: AbortController[] = [];

  beforeEach(async () => {
    host = new SessionHost();
    host.registerBackend(new FakeBackend());
    id = await host.create({ scope: "/tmp", backend: "fake", modelId: "fake-1" });
    log = host.logFor(id);
    fill(log);
    running = await serve({ host, token, assets: {} });
  });

  afterEach(async () => {
    for (const abort of aborters.splice(0)) abort.abort();
    await running.close();
    await host.dispose(id);
  });

  const get = (path: string, authenticate = true) => fetch(`${running.url}${path}`, {
    headers: authenticate ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  const url = (suffix = "") => `/api/sessions/${id}/presentation${suffix}`;
  const stream = async (path: string) => {
    const abort = new AbortController();
    aborters.push(abort);
    const response = await fetch(`${running.url}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    return { ...frames(response), abort };
  };

  it("sends a current snapshot FIRST, streams continuous updates, and refreshes the loaded suffix on reconnect", async () => {
    const sse = await stream(url("/events"));
    const first = await sse.next<PresentationSnapshot>();
    assert.equal(first.type, "snapshot");
    assert.equal(first.entries.length, 400);
    assert.equal(first.seq, log.lastSeq);
    assert.deepEqual(first.state, metadata(reduceAll(log.since(0))));
    log.append({ type: "message", id: "m-0", text: "late old text", final: true }, AT);
    const late = await sse.next<PresentationUpdate>();
    assert.equal(late.type, "update");
    assert.equal(late.entries[0]?.index, 0);
    assert.ok(!("state" in late));
    log.append({ type: "turn_started", turnId: "running" }, AT);
    const chrome = await sse.next<PresentationUpdate>();
    assert.equal(chrome.state?.status, "running");
    assert.deepEqual(chrome.entries, []);
    log.append({ type: "message", id: "new", text: "new row", final: false }, AT);
    const text = await sse.next<PresentationUpdate>();
    assert.equal(text.seq, log.lastSeq);
    assert.equal(text.entries[0]?.index, first.total);
    assert.ok(!("state" in text));
    sse.abort.abort();
    const reconnect = await stream(url(`/events?start=${first.start - 20}&limit=400`));
    const refreshed = await reconnect.next<PresentationSnapshot>();
    assert.equal(refreshed.type, "snapshot");
    assert.equal(refreshed.start, first.start - 20);
    assert.equal(refreshed.entries.length, 421);
    assert.equal(refreshed.state.status, "running");
    assert.equal(refreshed.seq, log.lastSeq);
    const complete = await stream(url("/events?start=0"));
    assert.equal((await complete.next<PresentationSnapshot>()).entries.length, log.presentationPage().total);
    const empty = await stream(url(`/events?start=${text.total}`));
    assert.deepEqual((await empty.next<PresentationSnapshot>()).entries, []);
    log.append({ type: "notice", text: "after empty suffix", level: "info" }, AT);
    assert.equal((await empty.next<PresentationUpdate>()).entries[0]?.index, text.total);
  });

  it("emits Idle keepalive comments without appending events and clears the timer on disconnect", async (t) => {
    const originalInterval = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    let heartbeat: (() => void) | undefined;
    let cleared = false;
    const timer = { unref: () => timer } as unknown as ReturnType<typeof setInterval>;
    // Drive only the presentation heartbeat; no fifteen-second sleep or extra durable event.
    t.mock.method(globalThis, "setInterval", (callback: () => void, milliseconds: number) => {
      if (milliseconds !== 15_000) return originalInterval(callback, milliseconds);
      heartbeat = callback;
      return timer;
    });
    t.mock.method(globalThis, "clearInterval", (handle: Parameters<typeof clearInterval>[0]) => {
      if (handle === timer) cleared = true;
      else originalClear(handle);
    });
    const abort = new AbortController();
    aborters.push(abort);
    const response = await fetch(`${running.url}${url("/events")}`, {
      headers: { authorization: `Bearer ${token}` }, signal: abort.signal,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let snapshot = "";
    while (!snapshot.includes("\n\n")) snapshot += decoder.decode((await reader.read()).value);
    const seq = log.lastSeq;
    assert.ok(heartbeat);
    heartbeat();
    assert.equal(decoder.decode((await reader.read()).value), ": keepalive\n\n");
    assert.equal(log.lastSeq, seq);
    abort.abort();
    for (let i = 0; i < 100 && !cleared; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cleared, true, "closed clients must not retain heartbeat timers");
  });

  it("serves backward pages current as-of seq and leaves Settled Agent Sessions unrevived", async () => {
    await host.settle(id);
    const before = host.list();
    const response = await get(url());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const tail = await response.json() as PresentationPage;
    assert.equal(tail.entries.length, 400);
    assert.equal(tail.seq, log.lastSeq);
    const older = await (await get(url(`?before=${tail.start}&limit=20`))).json() as PresentationPage;
    assert.equal(older.entries.length, 20);
    assert.equal(older.entries.at(-1)?.index, tail.start - 1);
    assert.equal(older.seq, log.lastSeq);
    assert.deepEqual((await (await get(url("?before=0"))).json() as PresentationPage).entries, []);
    const sse = await stream(url("/events"));
    assert.equal((await sse.next<PresentationSnapshot>()).state.status, "settled");
    assert.deepEqual(host.list(), before, "reading must not attach a Backend Session");
    assert.equal(log.lastSeq, tail.seq);
  });

  it("keeps the existing raw event replay and continuous stream unchanged", async () => {
    const raw = await stream(`/api/sessions/${id}/events?since=${log.lastSeq - 2}`);
    const expected = log.since(log.lastSeq - 2);
    assert.deepEqual(await raw.next<LoggedEvent>(), expected[0]);
    assert.deepEqual(await raw.next<LoggedEvent>(), expected[1]);
    const appended = log.append({ type: "message", id: "raw", text: "raw snapshot", final: false }, AT);
    assert.deepEqual(await raw.next<LoggedEvent>(), appended);
    const caughtUp = await stream(`/api/sessions/${id}/events?since=${log.lastSeq}`);
    const next = log.append({ type: "message", id: "raw", text: "final snapshot", final: true }, AT);
    assert.deepEqual(await caughtUp.next<LoggedEvent>(), next);
  });

  it("enforces auth, missing logs and integer/bounds validation before opening SSE", async () => {
    for (const suffix of ["", "/events"]) {
      assert.equal((await get(url(suffix), false)).status, 401);
      assert.equal((await get(`/api/sessions/missing/presentation${suffix}`)).status, 404);
      for (const bad of ["0", "-1", "401", "NaN", "1.5", "Infinity", "", "9007199254740992"]) {
        assert.equal((await get(url(`${suffix}?limit=${bad}`))).status, 400, `limit=${bad}`);
      }
      const key = suffix ? "start" : "before";
      for (const bad of ["-1", "NaN", "1.5", "Infinity", "", "9007199254740992", String(log.presentationPage().total + 1)]) {
        assert.equal((await get(url(`${suffix}?${key}=${bad}`))).status, 400, `${key}=${bad}`);
      }
    }
    const one = await (await get(url("?limit=1"))).json() as PresentationPage;
    assert.equal(one.entries.length, 1);
    const sse = await stream(url("/events?limit=1"));
    assert.equal((await sse.next<PresentationSnapshot>()).entries.length, 1);
  });

  it("registers browser SSE with the OIDC lifetime gate and detaches on close", async () => {
    await running.close();
    let end: (() => void) | undefined;
    let detached = 0;
    let registered: string | undefined;
    const gate = {
      config: { publicAppUrl: "https://flow.example" },
      authenticate: async () => "browser-session",
      registerConnection: (sessionId: string, close: () => void) => {
        registered = sessionId;
        end = close;
        return () => { detached++; };
      },
      dispose: () => {},
    } as unknown as OidcGate;
    running = await serve({ host, token, assets: {}, oidc: gate });
    const response = await fetch(`${running.url}${url("/events")}`, {
      headers: { cookie: "browser-cookie" }, signal: AbortSignal.timeout(5000),
    });
    const sse = frames(response);
    assert.equal((await sse.next<PresentationSnapshot>()).type, "snapshot");
    assert.equal(registered, "browser-session");
    end!();
    assert.equal((await sse.reader.read()).done, true);
    assert.equal(detached, 1);
  });
});
