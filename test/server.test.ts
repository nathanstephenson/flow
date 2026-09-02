import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { readOrCreateToken } from "../src/daemon/auth.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { connect, type Connection, type LinkState } from "../src/client/connection.ts";
import { reduceAll } from "../src/client/reduce.ts";
import type { LoggedEvent } from "../src/protocol/events.ts";

describe("Session Host transport", () => {
  let root: string;
  let running: RunningServer;
  let client: Connection;
  let backend: FakeBackend;
  let host: SessionHost;
  let token: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "goodharness-http-"));
    token = readOrCreateToken(root);
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    running = await serve({ host, token });
    client = connect({ url: running.url, token });
  });

  afterEach(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stores the token 0600, because a client can run arbitrary commands", () => {
    const mode = statSync(join(root, "token")).mode & 0o777;
    assert.equal(mode.toString(8), "600");
  });

  it("refuses an unauthenticated command", async () => {
    const response = await fetch(`${running.url}/api/sessions`);
    assert.equal(response.status, 401);
  });

  it("refuses a wrong token", async () => {
    const response = await fetch(`${running.url}/api/sessions`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    assert.equal(response.status, 401);
  });

  it("refuses a cross-origin request even with a valid token", async () => {
    const response = await fetch(`${running.url}/api/sessions`, {
      headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    });
    assert.equal(response.status, 403, "a hostile page must not command loopback");
  });

  it("hands a token in a URL over to an HttpOnly cookie", async () => {
    const response = await fetch(`${running.url}/auth?token=${token}`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it("accepts the cookie the handoff set", async () => {
    const response = await fetch(`${running.url}/api/sessions`, {
      headers: { cookie: `goodharness=${token}` },
    });
    assert.equal(response.status, 200);
  });

  it("creates and drives a session over the wire", async () => {
    const sessionId = await client.command<string>({
      type: "create",
      scope: "/tmp/scope",
      backend: "fake",
    });
    await client.command({ type: "send", sessionId, text: "hello", when: "now" });
    assert.deepEqual(backend.latest.prompts, ["hello"]);

    const sessions = await client.listSessions();
    assert.equal(sessions[0]?.id, sessionId);
  });

  it("replays from `since` and then follows live", async () => {
    const sessionId = await client.command<string>({
      type: "create",
      scope: "/tmp/scope",
      backend: "fake",
    });
    await client.command({ type: "send", sessionId, text: "hello", when: "now" });

    const received: LoggedEvent[] = [];
    let sawTurnEnd: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      sawTurnEnd = resolve;
    });
    const unsubscribe = client.subscribe({
      sessionId,
      since: 0,
      onEntry: (entry) => {
        received.push(entry);
        if (entry.event.type === "turn_ended") sawTurnEnd?.();
      },
    });

    await waitFor(() => received.length >= 3);
    backend.latest.say("hi there");
    backend.latest.completeTurn();
    await ended;
    unsubscribe();

    assert.deepEqual(
      received.map((entry) => entry.seq),
      Array.from({ length: received.length }, (_, index) => index + 1),
      "a subscriber sees a contiguous transcript",
    );
    const state = reduceAll(received);
    assert.equal(state.entries.find((entry) => entry.kind === "assistant")?.text, "hi there");
  });

  it("lets a late subscriber catch up to the same state", async () => {
    const sessionId = await client.command<string>({
      type: "create",
      scope: "/tmp/scope",
      backend: "fake",
    });
    await client.command({ type: "send", sessionId, text: "hello", when: "now" });
    backend.latest.say("hi there");
    backend.latest.completeTurn();

    const all: LoggedEvent[] = [];
    const unsubscribe = client.subscribe({ sessionId, since: 0, onEntry: (entry) => all.push(entry) });
    await waitFor(() => all.some((entry) => entry.event.type === "turn_ended"));
    unsubscribe();

    const late: LoggedEvent[] = [];
    const unsubscribeLate = client.subscribe({ sessionId, since: 3, onEntry: (entry) => late.push(entry) });
    await waitFor(() => late.some((entry) => entry.event.type === "turn_ended"));
    unsubscribeLate();

    assert.deepEqual(reduceAll(late, reduceAll(all.slice(0, 3))), reduceAll(all));
  });

  it("reports an unknown session rather than hanging the subscriber", async () => {
    let failure: Error | undefined;
    const unsubscribe = client.subscribe({
      sessionId: "nope",
      since: 0,
      onEntry: () => undefined,
      onError: (error) => {
        failure = error;
      },
    });
    await waitFor(() => failure !== undefined);
    unsubscribe();
    assert.match(failure?.message ?? "", /404/);
  });

  it("starts a resumed stream that has nothing to replay", async () => {
    const sessionId = await client.command<string>({
      type: "create",
      scope: "/tmp/scope",
      backend: "fake",
    });
    await client.command({ type: "send", sessionId, text: "hello", when: "now" });
    backend.latest.say("hi there");
    backend.latest.completeTurn();

    const all: LoggedEvent[] = [];
    const unsubscribe = client.subscribe({ sessionId, since: 0, onEntry: (entry) => all.push(entry) });
    await waitFor(() => all.some((entry) => entry.event.type === "turn_ended"));
    unsubscribe();

    // Exactly what a reconnect asks for: resume at lastSeq, where log.since() yields nothing. The
    // stream must still start, or a client would sit connecting until the Agent Session next spoke
    // — and its silence watchdog would keep reconnecting to a stream that was never the problem.
    let link: LinkState | undefined;
    const resumed = client.subscribe({
      sessionId,
      since: reduceAll(all).lastSeq,
      onEntry: () => undefined,
      onLink: (state) => {
        link = state;
      },
    });
    await waitFor(() => link === "live");
    resumed();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
