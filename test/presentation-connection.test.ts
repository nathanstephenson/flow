import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { connect, type LinkState } from "../src/client/connection.ts";
import { initialState, reduceAll } from "../src/client/reduce.ts";
import type { AgentEvent, LoggedEvent } from "../src/protocol/events.ts";
import type { PresentationPage, PresentationSnapshot, PresentationUpdate } from "../src/protocol/presentation.ts";

// The durable transcript contains a past Running turn. Joining the reduced stream must expose only
// its current Idle activity, even while the tail still contains the answer produced by that turn.
const events: AgentEvent[] = [
  { type: "user_message", id: "u1", text: "old question" },
  { type: "turn_started", turnId: "t1" },
  { type: "message", id: "a1", text: "old answer", final: true },
  { type: "turn_ended", turnId: "t1", reason: "complete" },
];
const transcript: LoggedEvent[] = events.map((event, index) => ({
  seq: index + 1, sessionId: "s1", at: "2026-01-01T00:00:00.000Z", event,
}));
const { entries: reducedEntries, lastSeq, ...reducedState } = reduceAll(transcript);
// JSON omits absent optional metadata; compare the actual wire shape rather than reducer objects.
const state = JSON.parse(JSON.stringify(reducedState)) as PresentationSnapshot["state"];
const SNAPSHOT: PresentationSnapshot = {
  type: "snapshot", seq: lastSeq, state,
  entries: [{ index: 1, entry: reducedEntries[1]! }],
  related: [{ index: 0, entry: reducedEntries[0]! }],
  start: 1, total: reducedEntries.length,
};
const UPDATE: PresentationUpdate = {
  type: "update", seq: lastSeq + 1,
  state: { ...state, status: "running", turnInFlight: true },
  entries: [{ index: 2, entry: { kind: "assistant", id: "a2", text: "new", final: false } }],
  total: 3,
};
const PAGE: PresentationPage = {
  seq: lastSeq, entries: [{ index: 0, entry: reducedEntries[0]! }], start: 0, total: 2,
};

// These are transport tests, not reducer/cache or browser merge tests: ordinals and versions must
// survive untouched so their owners can merge live patches and backward pages safely.
describe("Connection reduced Presentation Transcript", () => {
  it("does not become live on flushed headers; delivers the current snapshot before continuous updates", async (t) => {
    const host = await fakeHost((_request, response) => openStream(response));
    const links: LinkState[] = [];
    const order: string[] = [];
    const snapshots: PresentationSnapshot[] = [];
    const updates: PresentationUpdate[] = [];
    const stop = connect({ url: host.url, token: "secret" }).subscribePresentation({
      sessionId: "s1", start: () => undefined,
      onSnapshot: (snapshot) => { snapshots.push(snapshot); order.push("snapshot"); },
      onUpdate: (update) => { updates.push(update); order.push("update"); },
      onLink: (link) => { links.push(link); order.push(link); },
    });
    t.after(async () => { stop(); await host.close(); });

    await waitFor(() => host.responses.length === 1);
    await delay(30);
    assert.deepEqual(links, ["connecting"], "HTTP 200 is not yet current activity");
    assert.equal(snapshots.length, 0);
    assert.equal(host.requests[0]?.url, "/api/sessions/s1/presentation/events?limit=400");
    assert.equal(host.requests[0]?.authorization, "Bearer secret");

    host.responses[0]!.write(frame(SNAPSHOT));
    await waitFor(() => links.includes("live"));
    assert.deepEqual(order, ["connecting", "snapshot", "live"]);
    assert.deepEqual(snapshots, [SNAPSHOT]);
    assert.equal(snapshots[0]?.state.status, "idle");
    assert.equal(snapshots[0]?.state.turnInFlight, false);
    assert.equal("entries" in snapshots[0]!.state, false);
    assert.equal("lastSeq" in snapshots[0]!.state, false);
    assert.deepEqual(updates, [], "historical Running activity is never replayed");

    const completed: PresentationUpdate = {
      type: "update", seq: UPDATE.seq + 1, state: initialStateMetadata(),
      entries: [{ index: 2, entry: { kind: "assistant", id: "a2", text: "new answer", final: true } }],
      total: 3,
    };
    const entryOnly: PresentationUpdate = { type: "update", seq: completed.seq + 1, entries: [], total: 3 };
    host.responses[0]!.write(frame(UPDATE) + frame(completed) + frame(entryOnly));
    await waitFor(() => updates.length === 3);
    assert.deepEqual(updates, [UPDATE, completed, entryOnly]);
    assert.deepEqual(links, ["connecting", "live"], "updates do not repeatedly announce live");
  });

  it("parses split SSE delimiters, multiple frames, multiline data, comments and split UTF-8", async (t) => {
    const host = await fakeHost((_request, response) => openStream(response));
    const snapshots: PresentationSnapshot[] = [];
    const updates: PresentationUpdate[] = [];
    const errors: Error[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => undefined,
      onSnapshot: (snapshot) => snapshots.push(snapshot), onUpdate: (update) => updates.push(update),
      onError: (error) => errors.push(error),
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => host.responses.length === 1);
    const snapshot: PresentationSnapshot = {
      ...SNAPSHOT, entries: [{ index: 1, entry: { kind: "assistant", id: "a1", text: "café 🦊", final: true } }],
    };
    // Newlines between JSON properties are valid JSON; the host's SSE parser joins data lines.
    const json = JSON.stringify(snapshot);
    const boundary = json.indexOf(',"entries"');
    const bytes = Buffer.from(`: heartbeat\n\nid: ${snapshot.seq}\ndata: ${json.slice(0, boundary + 1)}\ndata: ${json.slice(boundary + 1)}\n\n`);
    const unicode = bytes.indexOf(Buffer.from("🦊"));
    const response = host.responses[0]!;
    response.write(bytes.subarray(0, unicode + 1));
    await delay(10);
    assert.equal(snapshots.length, 0);
    response.write(bytes.subarray(unicode + 1, bytes.length - 1));
    await delay(10);
    assert.equal(snapshots.length, 0, "a single trailing newline does not end an SSE frame");
    response.write(Buffer.concat([bytes.subarray(bytes.length - 1), Buffer.from(frame(UPDATE))]));
    await waitFor(() => updates.length === 1);
    assert.deepEqual(snapshots, [snapshot]);
    assert.deepEqual(updates, [UPDATE]);
    assert.deepEqual(errors, []);
  });

  it("reevaluates the oldest loaded ordinal on reconnect and refreshes that entire suffix", async (t) => {
    const refreshed: PresentationSnapshot = { ...SNAPSHOT, entries: PAGE.entries.concat(SNAPSHOT.entries), related: [], start: 0 };
    const host = await fakeHost((_request, response, attempt) => {
      openStream(response);
      response.write(frame(attempt === 1 ? SNAPSHOT : refreshed));
    });
    let oldest: number | undefined;
    const snapshots: PresentationSnapshot[] = [];
    const links: LinkState[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => oldest,
      onSnapshot: (snapshot) => { snapshots.push(snapshot); oldest = snapshot.start; },
      onUpdate: () => undefined, onLink: (link) => links.push(link),
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => snapshots.length === 1);
    // A backward page was merged while this stream stayed open.
    oldest = 0;
    host.responses[0]!.end();
    await waitFor(() => snapshots.length === 2);
    assert.deepEqual(host.requests.map((request) => request.url), [
      "/api/sessions/s1/presentation/events?limit=400",
      "/api/sessions/s1/presentation/events?limit=400&start=0",
    ]);
    assert.deepEqual(snapshots[1], refreshed);
    assert.deepEqual(links, ["connecting", "live", "retrying", "connecting", "live"]);
  });

  it("comment heartbeats keep an Idle snapshot live without replaying rows or activity", async (t) => {
    const host = await fakeHost((_request, response) => {
      openStream(response);
      response.write(frame(SNAPSHOT));
    });
    const links: LinkState[] = [];
    const snapshots: PresentationSnapshot[] = [];
    const updates: PresentationUpdate[] = [];
    const errors: Error[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => undefined, silenceMs: 100,
      onSnapshot: snapshot => snapshots.push(snapshot), onUpdate: update => updates.push(update),
      onLink: link => links.push(link), onError: error => errors.push(error),
    });
    const heartbeat = setInterval(() => host.responses[0]?.write(": keepalive\n\n"), 20);
    t.after(async () => { clearInterval(heartbeat); stop(); await host.close(); });
    await waitFor(() => links.includes("live"));
    await delay(320);
    assert.equal(host.requests.length, 1, "healthy Idle streams must not repeatedly download the loaded suffix");
    assert.deepEqual(links, ["connecting", "live"]);
    assert.deepEqual(snapshots, [SNAPSHOT]);
    assert.deepEqual(updates, []);
    assert.deepEqual(errors, []);
  });

  it("silence before a snapshot retries quietly without announcing live", async (t) => {
    const host = await fakeHost((_request, response, attempt) => {
      openStream(response);
      if (attempt > 1) response.write(frame(SNAPSHOT));
    });
    let oldest = 12;
    const links: LinkState[] = [];
    const errors: Error[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => oldest, silenceMs: 60,
      onSnapshot: () => undefined, onUpdate: () => undefined,
      onError: (error) => errors.push(error),
      onLink: (link) => { links.push(link); if (link === "retrying") oldest = 4; },
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => links.includes("live"));
    stop();
    assert.deepEqual(links.slice(0, 4), ["connecting", "retrying", "connecting", "live"]);
    assert.deepEqual(host.requests.slice(0, 2).map((request) => new URL(request.url, host.url).searchParams.get("start")), ["12", "4"]);
    assert.deepEqual(errors, [], "the watchdog's own abort is not a user-visible error");
  });

  it("silence after a snapshot refreshes the loaded suffix without reporting an abort", async (t) => {
    const host = await fakeHost((_request, response) => { openStream(response); response.write(frame(SNAPSHOT)); });
    const snapshots: PresentationSnapshot[] = [];
    const errors: Error[] = [];
    const links: LinkState[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => snapshots.length ? 0 : undefined, silenceMs: 60,
      onSnapshot: (snapshot) => snapshots.push(snapshot), onUpdate: () => undefined,
      onError: (error) => errors.push(error), onLink: (link) => links.push(link),
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => snapshots.length >= 2);
    stop();
    assert.deepEqual(links.slice(0, 5), ["connecting", "live", "retrying", "connecting", "live"]);
    assert.equal(host.requests[1]?.url, "/api/sessions/s1/presentation/events?limit=400&start=0");
    assert.deepEqual(errors, []);
  });

  it("rejects an update before the initial snapshot and retries without exposing historical activity", async (t) => {
    const host = await fakeHost((_request, response, attempt) => {
      openStream(response);
      response.write(frame(attempt === 1 ? UPDATE : SNAPSHOT));
    });
    const snapshots: PresentationSnapshot[] = [];
    const updates: PresentationUpdate[] = [];
    const errors: Error[] = [];
    const links: LinkState[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => undefined,
      onSnapshot: (snapshot) => snapshots.push(snapshot), onUpdate: (update) => updates.push(update),
      onError: (error) => errors.push(error), onLink: (link) => links.push(link),
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => snapshots.length === 1);
    stop();
    assert.deepEqual(updates, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /did not begin with a snapshot/);
    assert.deepEqual(links, ["connecting", "retrying", "connecting", "live"]);
  });

  it("stop aborts a pending fetch and clears its silence timer without retrying", async (t) => {
    let closed = false;
    const host = await fakeHost((_request, response) => {
      response.on("close", () => { closed = true; });
      // Deliberately neither headers nor snapshot: fetch itself is still pending.
    });
    const links: LinkState[] = [];
    const errors: Error[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => undefined, silenceMs: 40,
      onSnapshot: () => assert.fail("stopped subscription received a snapshot"),
      onUpdate: () => assert.fail("stopped subscription received an update"),
      onLink: (link) => links.push(link), onError: (error) => errors.push(error),
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => host.requests.length === 1);
    stop();
    stop(); // Unsubscribing twice is harmless.
    await waitFor(() => closed);
    await delay(100);
    assert.deepEqual(links, ["connecting"]);
    assert.deepEqual(errors, []);
    assert.equal(host.requests.length, 1);
  });

  it("stop during reconnect backoff cancels the pending retry", async (t) => {
    const host = await fakeHost((_request, response) => {
      response.writeHead(503); response.end("temporarily unavailable");
    });
    const links: LinkState[] = [];
    const errors: Error[] = [];
    const stop = connect({ url: host.url, token: "t" }).subscribePresentation({
      sessionId: "s1", start: () => undefined,
      onSnapshot: () => assert.fail("503 cannot yield a snapshot"), onUpdate: () => undefined,
      onLink: (link) => links.push(link), onError: (error) => errors.push(error),
    });
    t.after(async () => { stop(); await host.close(); });
    await waitFor(() => links.includes("retrying"));
    stop();
    await delay(550); // Beyond the first backoff's maximum (500ms), not a mocked fetch.
    assert.deepEqual(links, ["connecting", "retrying"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /503.*temporarily unavailable/);
    assert.equal(host.requests.length, 1);
  });

  for (const status of [401, 403, 404]) {
    it(`${status} is terminal, with browser authentication handling but no bearer reauthentication`, async (t) => {
      const host = await fakeHost((_request, response) => {
        response.writeHead(status, { "x-flow-login": "/oauth/login" }); response.end("cannot read");
      });
      t.after(() => host.close());
      const stops: (() => void)[] = [];
      t.after(() => { for (const stop of stops) stop(); });
      for (const token of [undefined, "t"]) {
        const links: LinkState[] = [];
        const errors: Error[] = [];
        const authentication: number[] = [];
        stops.push(connect({
          url: host.url, token,
          authenticationRequired: (response) => {
            authentication.push(response.status);
            assert.equal(response.headers.get("x-flow-login"), "/oauth/login");
          },
        }).subscribePresentation({
          sessionId: "s1", start: () => undefined, silenceMs: 40,
          onSnapshot: () => assert.fail("terminal response yielded snapshot"), onUpdate: () => undefined,
          onLink: (link) => links.push(link), onError: (error) => errors.push(error),
        }));
        await waitFor(() => errors.length === 1);
        assert.deepEqual(links, ["connecting", "gone"]);
        assert.match(errors[0]!.message, new RegExp(`${status}.*cannot read`));
        assert.deepEqual(authentication, token ? [] : [status]);
      }
      await delay(550);
      assert.equal(host.requests.length, 2, "neither fatal subscription retries");
    });
  }

  it("reads a backward page with encoded Agent Session id, bearer token and exclusive before ordinal", async (t) => {
    const host = await fakeHost((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(PAGE));
    });
    t.after(() => host.close());
    const id = "folder/id ?% café";
    const page = await connect({ url: host.url, token: "page-secret" }).readPresentation(id, 1);
    assert.deepEqual(page, PAGE);
    assert.deepEqual(host.requests, [{
      method: "GET", url: `/api/sessions/${encodeURIComponent(id)}/presentation?before=1&limit=400`,
      authorization: "Bearer page-secret",
    }]);
  });

  it("uses browser cookie credentials for pages and streams without an Authorization header", async (t) => {
    const host = await fakeHost((request, response) => {
      if (request.url?.includes("/events?")) { openStream(response); response.write(frame(SNAPSHOT)); }
      else { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(PAGE)); }
    });
    const originalFetch = globalThis.fetch;
    const credentials: (string | undefined)[] = [];
    // Node has no cookie jar. Inspect the browser fetch option while still using real HTTP for both
    // requests, rather than claiming the fake Session Host observed a cookie Node cannot send.
    globalThis.fetch = (input, init) => { credentials.push(init?.credentials); return originalFetch(input, init); };
    let received = false;
    const connection = connect({ url: host.url });
    let stop: () => void = () => undefined;
    t.after(async () => { stop(); globalThis.fetch = originalFetch; await host.close(); });
    assert.deepEqual(await connection.readPresentation("s1", 1), PAGE);
    stop = connection.subscribePresentation({
      sessionId: "folder/id ?% café", start: () => 0,
      onSnapshot: () => { received = true; }, onUpdate: () => undefined,
    });
    await waitFor(() => received);
    assert.deepEqual(credentials, ["same-origin", "same-origin"]);
    assert.deepEqual(host.requests.map((request) => request.authorization), [undefined, undefined]);
    assert.equal(host.requests[1]?.url, `/api/sessions/${encodeURIComponent("folder/id ?% café")}/presentation/events?limit=400&start=0`);
  });

  it("cancels a backward page while its response body is pending", async (t) => {
    let closed = false;
    const host = await fakeHost((_request, response) => {
      response.on("close", () => { closed = true; });
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders(); response.write('{"seq":');
    });
    t.after(() => host.close());
    const controller = new AbortController();
    const result = connect({ url: host.url, token: "t" }).readPresentation("s1", 1, controller.signal);
    const rejected = assert.rejects(result, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await waitFor(() => host.requests.length === 1);
    controller.abort();
    await rejected;
    await waitFor(() => closed);
    assert.equal(host.requests.length, 1);
  });

  it("rejects refused pages once and uses the existing authentication callback policy", async (t) => {
    for (const status of [401, 403, 404]) {
      const host = await fakeHost((_request, response) => { response.writeHead(status); response.end("cannot read page"); });
      t.after(() => host.close());
      for (const token of [undefined, "t"]) {
        const authentication: number[] = [];
        await assert.rejects(connect({
          url: host.url, token, authenticationRequired: (response) => { authentication.push(response.status); },
        }).readPresentation("s1", 0), new RegExp(`${status}.*cannot read page`));
        assert.deepEqual(authentication, token ? [] : [status]);
      }
      assert.equal(host.requests.length, 2, "page reads are not automatically retried");
    }
  });
});

function initialStateMetadata(): PresentationSnapshot["state"] {
  const { entries: _entries, lastSeq: _lastSeq, ...metadata } = initialState();
  return metadata;
}

function frame(value: PresentationSnapshot | PresentationUpdate): string {
  return `id: ${value.seq}\ndata: ${JSON.stringify(value)}\n\n`;
}

function openStream(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.flushHeaders();
}

type Recorded = { method: string | undefined; url: string; authorization: string | undefined };
async function fakeHost(handler: (request: IncomingMessage, response: ServerResponse, attempt: number) => void) {
  const requests: Recorded[] = [];
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url ?? "/", authorization: request.headers.authorization });
    responses.push(response);
    handler(request, response, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, requests, responses,
    close: async () => {
      for (const response of responses) response.destroy();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3_000) throw new Error("timed out waiting for fake Presentation Transcript stream");
    await delay(5);
  }
}
