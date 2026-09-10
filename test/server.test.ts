import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { readOrCreateToken } from "../src/daemon/auth.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { connect, type Connection, type LinkState } from "../src/client/connection.ts";
import { reduceAll } from "../src/client/reduce.ts";
import type { LoggedEvent } from "../src/protocol/events.ts";
import type { BackendModels } from "../src/protocol/events.ts";
import type { BranchList } from "../src/protocol/git.ts";
import type { SessionSummary } from "../src/protocol/commands.ts";
import { repository } from "./git-fixture.ts";

describe("Session Host transport", () => {
  let root: string;
  let running: RunningServer;
  let client: Connection;
  let backend: FakeBackend;
  let host: SessionHost;
  let token: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-http-"));
    token = readOrCreateToken(root);
    backend = new FakeBackend();
    host = new SessionHost();
    host.registerBackend(backend);
    running = await serve({ host, token, assets: {} });
    client = connect({ url: running.url, token });
  });

  afterEach(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The Skill catalogue over the real transport.
   *
   * A command whose whole job is to answer with data rather than to change something, which is a
   * shape the protocol did not have until the composer's menu needed one — worth pinning end to end,
   * because a JSON round trip is where "returns an array" quietly becomes "returns null".
   */
  it("answers list_skills with the catalogue itself, not a wrapper", async () => {
    const id = await client.command<string>({ type: "create", scope: root, backend: "fake" });
    const skills = await client.command({ type: "list_skills", sessionId: id });

    assert.deepEqual(skills, [
      { name: "tdd", description: "Red, green, refactor" },
      { name: "review", description: "Review the diff", argumentHint: "[<pr#>|<branch>]" },
    ]);
  });

  describe("git over the wire", () => {
    const get = async (path: string) =>
      await fetch(`${running.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

    it("reports whether this build can run git at all", async () => {
      const config = (await (await get("/api/config")).json()) as { git: boolean };
      // The `shell` rule, applied to git: a client hides the control rather than offering one that
      // fails on click.
      assert.equal(config.git, true);
    });

    it("lists a repository's branches, and says where it is", async () => {
      const repo = repository(root, "api", ["feature"]);
      const response = await get(`/api/branches?scope=${encodeURIComponent(repo)}`);

      assert.equal(response.status, 200);
      const list = (await response.json()) as BranchList;
      assert.equal(list.repository, true);
      assert.equal(list.scope, repo);
      assert.deepEqual([...list.branches].sort(), ["feature", "main"]);
      assert.deepEqual(list.head, { name: "main" });
    });

    // Not a 404: the directory exists, and reporting the state distinguishes "not a repository"
    // from a typo better than a status code would.
    it("answers 200 for a directory that is not a repository", async () => {
      const plain = mkdtempSync(join(tmpdir(), "flow-plain-"));
      const response = await get(`/api/branches?scope=${encodeURIComponent(plain)}`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { scope: plain, repository: false, branches: [] });
      rmSync(plain, { recursive: true, force: true });
    });

    it("refuses a request with no scope", async () => {
      const response = await get("/api/branches");
      assert.equal(response.status, 400);
    });

  });

  describe("the model catalogue", () => {
    const get = async (path: string) =>
      await fetch(`${running.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

    it("reports what each Backend Adapter can reach", async () => {
      const listing = (await (await get("/api/models")).json()) as BackendModels[];

      assert.deepEqual(
        listing.map((entry) => entry.backend),
        ["fake"],
      );
      assert.deepEqual(
        listing[0]?.models.map((model) => model.id),
        ["fake-1", "fake-2"],
      );
      assert.equal(listing[0]?.problem, undefined);
    });

    // Not a 404, for the reason /api/branches answers 200 for a directory that is not a
    // repository: naming the state is what turns the picker into a text field rather than into an
    // empty list nobody can explain.
    it("answers 200 with a reason for a backend that cannot answer", async () => {
      host.registerBackend({
        name: "broken",
        create: async () => {
          throw new Error("not logged in");
        },
      });

      const listing = (await (await get("/api/models?refresh=1")).json()) as BackendModels[];
      const broken = listing.find((entry) => entry.backend === "broken");

      assert.deepEqual(broken, { backend: "broken", models: [], problem: "not logged in" });
    });
  });

  /**
   * The same catalogue for a Scope with no Agent Session in it — what the New Agent Session view
   * asks, and the half `list_skills` above cannot answer because it reads a live Backend Session.
   */
  describe("the Skill catalogue for a Scope", () => {
    const get = async (path: string) =>
      await fetch(`${running.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

    it("answers the Skills a Scope offers before any Agent Session exists", async () => {
      const response = await get(
        `/api/skills?scope=${encodeURIComponent(root)}&backend=fake`,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        backend: "fake",
        scope: root,
        skills: [
          { name: "tdd", description: "Red, green, refactor" },
          { name: "review", description: "Review the diff", argumentHint: "[<pr#>|<branch>]" },
        ],
      });
      assert.deepEqual(host.list(), [], "asking must not create an Agent Session");
    });

    it("refuses a request with no scope", async () => {
      assert.equal((await get("/api/skills?backend=fake")).status, 400);
    });

    // Defaulting would answer with a different adapter's menu than the session is created on: the
    // two adapters disagree about what a Skill is.
    it("refuses a request with no backend", async () => {
      assert.equal((await get(`/api/skills?scope=${encodeURIComponent(root)}`)).status, 400);
    });

    /*
     * The status is the whole point of this one. `CommandRefused` → 409 is wired only for
     * `POST /api/command`, so anything thrown in this handler reaches the reader as a bare 500 —
     * which is what a menu must never do to the view holding it.
     */
    it("answers 200 with a reason for a backend that cannot start", async () => {
      host.registerBackend({
        name: "broken",
        create: async () => {
          throw new Error("not logged in");
        },
      });

      const response = await get(
        `/api/skills?scope=${encodeURIComponent(root)}&backend=broken`,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        backend: "broken",
        scope: root,
        skills: [],
        problem: "not logged in",
      });
    });

    it("answers 200 naming a Backend Adapter it does not know", async () => {
      const response = await get(
        `/api/skills?scope=${encodeURIComponent(root)}&backend=nope`,
      );

      assert.equal(response.status, 200);
      assert.match(((await response.json()) as { problem: string }).problem, /No backend named/);
    });

    /**
     * A refusal is the caller's to fix, so it must not arrive as a 500.
     *
     * This is the first refusal `/api/command` distinguishes from a fault — `revive` on an Ended
     * session is the same kind of thing and is still a 500, which is a separate change.
     */
    it("answers 409, not 500, when an Agent Session's state forbids the command", async () => {
      const repo = repository(root, "busy", ["feature"]);
      const id = await host.create({ scope: repo, backend: "fake" });
      await host.send(id, "get to work", "now");

      const response = await fetch(`${running.url}/api/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "switch_branch", sessionId: id, branch: "feature" }),
      });

      assert.equal(response.status, 409);
      assert.match(((await response.json()) as { error: string }).error, /is running/);
    });

    it("carries the branch on the session list, so the rail can name it", async () => {
      const repo = repository(root, "listed");
      await host.create({ scope: repo, backend: "fake" });

      const sessions = (await (await get("/api/sessions")).json()) as SessionSummary[];
      assert.deepEqual(sessions[0]?.branch, { name: "main" });
    });
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
      headers: { cookie: `flow=${token}` },
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

/**
 * Serving an Attachment's bytes.
 *
 * Its own server because this is the one route that needs a TranscriptStore, and the suite above
 * deliberately runs a Session Host without one.
 */
describe("attachments over the wire", () => {
  let root: string;
  let running: RunningServer;
  let store: TranscriptStore;
  let token: string;
  let sessionId: string;
  let attachmentId: string;

  // A one-pixel PNG, so the bytes served back are a real image rather than a string that happens to
  // decode. `content-length` and `content-type` are only worth asserting against something true.
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gFj0X3TAAAAAElFTkSuQmCC";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-attach-"));
    token = readOrCreateToken(root);
    store = new TranscriptStore(root);
    const host = new SessionHost({ store });
    host.registerBackend(new FakeBackend());
    running = await serve({ host, token, store, assets: {} });
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake", modelId: "fake-1" });
    attachmentId = store.writeAttachment(sessionId, "image/png", pixel);
  });

  afterEach(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = async (path: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    await fetch(`${running.url}${path}`, { headers });

  const url = (id: string, session = sessionId) =>
    `/api/sessions/${encodeURIComponent(session)}/attachments/${encodeURIComponent(id)}`;

  it("serves the bytes with the media type its id names", async () => {
    const response = await get(url(attachmentId));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(pixel, "base64"));
  });

  /*
   * Cached forever on the same reasoning as a hashed asset: an id is minted per write and a
   * transcript is never rewritten (ADR 0001), so the bytes at an id cannot change. `private`
   * because the response went through a bearer check.
   */
  it("says the bytes may be cached forever, privately", async () => {
    const cacheControl = (await get(url(attachmentId))).headers.get("cache-control") ?? "";
    assert.match(cacheControl, /immutable/);
    assert.match(cacheControl, /private/);
  });

  it("refuses an unauthenticated request, like every other route", async () => {
    const response = await get(url(attachmentId), {});
    assert.equal(response.status, 401);
  });

  /*
   * The id check is the traversal guard: `mediaTypeOf` accepts a uuid and one of four extensions and
   * nothing else, so a path is refused for the same reason a `.txt` is, and there is no second rule
   * able to drift from the first.
   */
  it("refuses an id that is a path rather than a filename", async () => {
    for (const bad of ["../../token", "..%2f..%2ftoken", "token", `${attachmentId}.txt`]) {
      const response = await get(url(bad));
      assert.equal(response.status, 404, `${bad} must not be served`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    }
  });

  it("404s a well-formed id with nothing behind it", async () => {
    const response = await get(url("11111111-1111-4111-8111-111111111111.png"));
    assert.equal(response.status, 404);
  });

  /*
   * An Attachment is addressed under its Agent Session because that is where it lives, so the same
   * id under a different session is simply not there — the session is part of the address, not a
   * decoration on it.
   */
  it("does not serve one session's attachment from another", async () => {
    const response = await get(url(attachmentId, "some-other-session"));
    assert.equal(response.status, 404);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
