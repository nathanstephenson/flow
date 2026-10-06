import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { connect, type LinkState } from "../src/client/connection.ts";
import { initialState, reduce, reduceAll, type ViewState } from "../src/client/reduce.ts";
import type { AgentEvent, LoggedEvent } from "../src/protocol/events.ts";

/**
 * A Presentation Transcript containing the two Entry kinds whose ids are derived from the
 * transcript's length rather than from anything in the event — a notice and a Dormant marker
 * (reduce.ts). Those are the ones a reconnect that replays from 0 duplicates, so they are what
 * these tests are about.
 */
const EVENTS: AgentEvent[] = [
  {
    type: "session_started",
    backend: "fake",
    scope: "/tmp/scope",
    capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
  },
  { type: "user_message", id: "u1", text: "hello" },
  { type: "notice", level: "warn", text: "the backend hiccupped" },
  { type: "session_dormant", reason: "host restart" },
];

const TRANSCRIPT: LoggedEvent[] = EVENTS.map((event, index) => ({
  seq: index + 1,
  sessionId: "s1",
  at: new Date(1_700_000_000_000 + index).toISOString(),
  event,
}));

describe("Connection", () => {
  it("resumes from the last seq it saw, so a reconnect duplicates nothing", async (t) => {
    const host = await fakeSessionHost(TRANSCRIPT);
    let view: ViewState = initialState();
    const links: LinkState[] = [];

    const stop = connect({ url: host.url, token: "t" }).subscribe({
      sessionId: "s1",
      since: 0,
      onEntry: (entry) => {
        view = reduce(view, entry);
      },
      onLink: (link) => links.push(link),
    });
    t.after(async () => {
      stop();
      await host.close();
    });

    await waitFor(() => view.lastSeq === 4);
    // A proxy idle-timeout or a host restart: the stream simply stops, mid-transcript.
    host.drop();
    await waitFor(() => host.requests.length === 2 && links.includes("live", 3), 5_000, () =>
      JSON.stringify({ links, requests: host.requests }),
    );

    assert.deepEqual(
      host.requests.map((request) => request.since),
      [0, 4],
      "the second attempt must resume where the first stopped, not replay from 0",
    );
    assert.deepEqual(view, reduceAll(TRANSCRIPT), "a reconnect must leave the same ViewState");
    assert.equal(view.entries.filter((entry) => entry.kind === "notice").length, 1);
    assert.equal(view.entries.filter((entry) => entry.kind === "marker").length, 1);
    assert.deepEqual(links.slice(0, 3), ["connecting", "live", "retrying"]);
  });

  it("would duplicate them if it replayed from 0 instead", () => {
    // Not a test of the transport: it is the reason the one above matters. `notice-N`/`dormant-N`
    // take N from the transcript's length at the time, so a second pass over a state that already
    // holds them appends rather than upserts.
    const replayed = reduceAll(TRANSCRIPT, reduceAll(TRANSCRIPT));
    assert.equal(replayed.entries.filter((entry) => entry.kind === "notice").length, 2);
    assert.equal(replayed.entries.filter((entry) => entry.kind === "marker").length, 2);
  });

  it("treats a silent stream as a dead one and resumes it", async (t) => {
    // The Session Host sends no heartbeat, so nothing else recovers a stream a proxy dropped
    // without closing. 60ms here stands in for the 45s default.
    const host = await fakeSessionHost(TRANSCRIPT);
    let view: ViewState = initialState();

    const stop = connect({ url: host.url, token: "t" }).subscribe({
      sessionId: "s1",
      since: 0,
      onEntry: (entry) => {
        view = reduce(view, entry);
      },
      silenceMs: 60,
    });
    t.after(async () => {
      stop();
      await host.close();
    });

    await waitFor(() => host.requests.length >= 3);

    /*
     * The invariant is *where* each reconnect resumes from, not how many happened. The watchdog is a
     * repeating timer against a 60ms window and waitFor polls every 5ms, so under load the loop can
     * be delayed past a window and observe four or five requests rather than three — which failed an
     * assertion spelled `[4, 4]` while the property it was checking still held.
     */
    const resumes = host.requests.slice(1).map((request) => request.since);
    assert.ok(resumes.length >= 2, `expected at least two watchdog reconnects, saw ${resumes.length}`);
    assert.deepEqual(
      [...new Set(resumes)],
      [4],
      "every watchdog reconnect resumes from the same place, and replays nothing",
    );
    assert.deepEqual(view, reduceAll(TRANSCRIPT));
  });

  it("sends no Authorization header without a token, because the browser has a cookie", async (t) => {
    const host = await fakeSessionHost(TRANSCRIPT);
    const connection = connect({ url: host.url });

    await connection.listSessions();
    const stop = connection.subscribe({ sessionId: "s1", since: 0, onEntry: () => undefined });
    t.after(async () => {
      stop();
      await host.close();
    });
    await waitFor(() => host.requests.some((request) => request.path.endsWith("/events")));

    assert.deepEqual(
      host.requests.map((request) => request.authorization),
      [undefined, undefined],
    );
  });

  it("offers OIDC reauthentication without replaying a refused command", async (t) => {
    let requests = 0;
    let assigned: string | undefined;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(401, {
        "content-type": "application/json",
        "x-flow-login": "/oauth/login",
      });
      response.end(JSON.stringify({ error: "Unauthorized" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const browser = globalThis as typeof globalThis & {
      location?: { pathname: string; search: string; hash: string; assign(url: string): void };
    };
    browser.location = {
      pathname: "/",
      search: "",
      hash: "#/s/deep-link",
      assign: (url) => { assigned = url; },
    };
    t.after(() => { delete browser.location; });

    await assert.rejects(
      connect({
        url: `http://127.0.0.1:${port}`,
        authenticationRequired: (response) => {
          const login = response.headers.get("x-flow-login");
          if (response.status === 401 && login) browser.location?.assign(`${login}?return_to=%2F%23%2Fs%2Fdeep-link`);
        },
      }).command({
        type: "create",
        scope: "/tmp/scope",
        backend: "fake",
      }),
      /401/,
    );

    assert.equal(requests, 1, "the command is not replayed after authentication starts");
    assert.equal(assigned, "/oauth/login?return_to=%2F%23%2Fs%2Fdeep-link");
  });

  it("gives up on a status no retry can fix", async (t) => {
    const host = await fakeSessionHost(TRANSCRIPT, 404);
    const links: LinkState[] = [];
    let failure: Error | undefined;

    const stop = connect({ url: host.url, token: "t" }).subscribe({
      sessionId: "gone",
      since: 0,
      onEntry: () => undefined,
      onError: (error) => {
        failure = error;
      },
      onLink: (link) => links.push(link),
    });
    t.after(async () => {
      stop();
      await host.close();
    });
    await waitFor(() => failure !== undefined);

    assert.match(failure?.message ?? "", /404/);
    assert.deepEqual(links, ["connecting", "gone"]);
    assert.equal(host.requests.length, 1, "a reaped Agent Session must not be retried in a loop");
  });
});

describe("Connection HTTP errors", () => {
  const html = `<!DOCTYPE html><html><head><title>Cloudflare error</title></head><body>${"proxy diagnostics".repeat(1_000)}</body></html>`;
  const timeout = "524 Proxy timed out. Accepted commands may still be running. Check their status before retrying.";
  const cases = [
    { name: "preserves the JSON API error, not its envelope", contentType: "application/json; charset=utf-8", body: JSON.stringify({ error: "Agent Session is Running", diagnostics: "private details" }), expected: "502 Bad Gateway: Agent Session is Running" },
    { name: "recognizes an untyped JSON API error", contentType: "", body: '{"error":"Scope is required"}', expected: "502 Bad Gateway: Scope is required" },
    { name: "discards Cloudflare HTML", contentType: "text/html; charset=UTF-8", body: html, expected: "502 Bad Gateway" },
    { name: "discards markup mislabeled as plain text", contentType: "text/plain", body: html, expected: "502 Bad Gateway" },
    { name: "discards untyped markup", contentType: "", body: ` \n${html}`, expected: "502 Bad Gateway" },
    { name: "discards markup inside a JSON error", contentType: "application/json", body: JSON.stringify({ error: html }), expected: "502 Bad Gateway" },
    { name: "normalizes plain text whitespace and controls", contentType: "text/plain", body: "  upstream\n\t temporarily\u0000 unavailable  ", expected: "502 Bad Gateway: upstream temporarily unavailable" },
    { name: "bounds plain text", contentType: "text/plain", body: "x".repeat(10_000), expected: `502 Bad Gateway: ${"x".repeat(239)}…` },
    { name: "bounds JSON error text too", contentType: "application/json", body: JSON.stringify({ error: "x".repeat(10_000) }), expected: `502 Bad Gateway: ${"x".repeat(239)}…` },
    { name: "falls back for an empty body", contentType: "text/plain", body: "", expected: "502 Bad Gateway" },
    { name: "falls back for whitespace", contentType: "text/plain", body: " \n\t ", expected: "502 Bad Gateway" },
    { name: "does not expose malformed JSON", contentType: "application/json", body: '{"error":', expected: "502 Bad Gateway" },
    { name: "does not expose other JSON fields", contentType: "application/json", body: '{"diagnostics":"private details"}', expected: "502 Bad Gateway" },
    { name: "does not stringify a structured error", contentType: "application/json", body: '{"error":{"details":"private details"}}', expected: "502 Bad Gateway" },
    { name: "handles JSON null", contentType: "application/json", body: "null", expected: "502 Bad Gateway" },
    { name: "explains a 524 HTML timeout without recommending blind retry", status: 524, contentType: "text/html", body: html, expected: timeout },
    { name: "explains an empty 524 timeout", status: 524, contentType: "", body: "", expected: timeout },
  ];

  for (const scenario of cases) {
    it(scenario.name, async (t) => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests += 1;
        response.writeHead(scenario.status ?? 502, scenario.contentType ? { "content-type": scenario.contentType } : {});
        response.end(scenario.body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
      const { port } = server.address() as AddressInfo;

      await assert.rejects(
        connect({ url: `http://127.0.0.1:${port}`, token: "t" }).command({ type: "create", scope: "/tmp/scope", backend: "fake" }),
        { message: scenario.expected },
      );
      assert.equal(requests, 1, "an HTTP error must not cause the command to be replayed");
    });
  }

  it("uses the safe formatter for queries and event-stream failures too", async (t) => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/html" });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const connection = connect({ url: `http://127.0.0.1:${port}`, token: "t" });

    await assert.rejects(connection.listSessions(), { message: "404 Not Found" });
    await assert.rejects(connection.branches("/tmp/scope"), { message: "404 Not Found" });
    let failure: Error | undefined;
    const stop = connection.subscribe({ sessionId: "s1", since: 0, onEntry: () => undefined, onError: (error) => { failure = error; } });
    t.after(stop);
    await waitFor(() => failure !== undefined);
    assert.equal(failure?.message, "404 Not Found");
  });

  it("retains the HTTP status when the error body cannot be read", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("body interrupted")); },
    }), { status: 502, statusText: "Bad Gateway" }));
    await assert.rejects(connect({ url: "http://unused", token: "t" }).listSessions(), { message: "502 Bad Gateway" });
  });
});

type Recorded = { path: string; since: number; authorization: string | undefined };

/**
 * The event-stream half of the Session Host, small enough that a test can drop a stream on demand.
 * `transcript.slice(since)` is deliberately the same exclusive slice as SessionLog.since.
 */
async function fakeSessionHost(
  transcript: LoggedEvent[],
  eventsStatus = 200,
): Promise<{ url: string; requests: Recorded[]; drop: () => void; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  let live: ServerResponse | undefined;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      path: url.pathname,
      since: Number(url.searchParams.get("since") ?? 0),
      authorization: request.headers.authorization,
    });

    if (!url.pathname.endsWith("/events")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (eventsStatus !== 200) {
      response.writeHead(eventsStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // As the real host does, and for the same reason: with nothing to replay there is no body write
    // to carry the buffered headers, so a resuming client would never see the response start.
    response.flushHeaders();
    for (const entry of transcript.slice(Number(url.searchParams.get("since") ?? 0))) {
      response.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    live = response;
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** How a proxy idle-timeout or a host restart ends a stream: no frame, no close, just gone. */
    drop: () => {
      live?.destroy();
      live = undefined;
    },
    close: async () => {
      live?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000, detail?: () => string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for condition${detail ? `: ${detail()}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
