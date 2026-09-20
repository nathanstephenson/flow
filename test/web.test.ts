import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { FIXTURE_ASSETS, FIXTURE_ICON_PATHS } from "./assets-fixture.ts";

const TOKEN = "web-test-token";
const IMMUTABLE = "public, max-age=31536000, immutable";
const ICON_CACHE = "public, max-age=3600, must-revalidate";

/**
 * How the Session Host serves a web client, given one.
 *
 * It is given a fixture rather than the real bundle because the real bundle is a build artifact the
 * binary build embeds and nothing else produces (ADR 0017). Every assertion here is about routing,
 * so a small hand-written manifest exercises it exactly as 2.5 MB of Vite output would — and the
 * suite keeps running on a fresh clone with no web/dist and under --omit=dev with no Vite.
 */
describe("web assets", () => {
  let running: RunningServer;

  before(async () => {
    const host = new SessionHost();
    host.registerBackend(new FakeBackend());
    running = await serve({ host, token: TOKEN, scope: "/tmp/scope", assets: FIXTURE_ASSETS });
  });

  after(async () => {
    await running.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${running.url}${path}`, { headers: { cookie: `flow=${TOKEN}`, ...headers } });

  it("serves the Entry Document at / and every asset at its own URL", async () => {
    const entryDocument = await get("/");
    assert.equal(entryDocument.status, 200);
    assert.match(entryDocument.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(entryDocument.headers.get("cache-control"), "no-store");
    const html = await entryDocument.text();
    for (const path of FIXTURE_ICON_PATHS) assert.match(html, new RegExp(`href="${path.replace(".", "\\.")}"`), path);

    for (const [path, asset] of Object.entries(FIXTURE_ASSETS)) {
      if (!asset) continue;
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), asset.type, path);
      assert.equal(
        response.headers.get("cache-control"),
        FIXTURE_ICON_PATHS.includes(path as typeof FIXTURE_ICON_PATHS[number])
          ? ICON_CACHE
          : asset.immutable ? IMMUTABLE : "no-store",
        path,
      );
    }
  });

  it("serves only the explicit icon allowlist publicly for GET and bodyless HEAD", async () => {
    for (const path of FIXTURE_ICON_PATHS) {
      const asset = FIXTURE_ASSETS[path]!;
      const response = await fetch(`${running.url}${path}`);
      const bytes = await response.arrayBuffer();
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), asset.type, path);
      assert.equal(response.headers.get("cache-control"), ICON_CACHE, path);
      assert.equal(bytes.byteLength, Buffer.from(asset.body, asset.encoding).byteLength, path);
      assert.doesNotMatch(Buffer.from(bytes).toString("utf8"), /<!doctype html>/i, path);

      const head = await fetch(`${running.url}${path}`, { method: "HEAD" });
      assert.equal(head.status, 200, path);
      assert.equal(head.headers.get("content-type"), asset.type, path);
      assert.equal(Number(head.headers.get("content-length")), bytes.byteLength, path);
      assert.equal((await head.arrayBuffer()).byteLength, 0, path);
    }

    for (const path of ["/not-an-icon.svg", "/assets/index-Ab12Cd34.js"]) {
      assert.equal((await fetch(`${running.url}${path}`)).status, 401, path);
    }
    assert.equal((await fetch(`${running.url}/favicon.svg`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${running.url}/favicon.svg`, {
      method: "POST",
      headers: { cookie: `flow=${TOKEN}` },
    })).status, 404);
  });

  it("requires authentication for the UI itself, not just the API", async () => {
    // The hashed assets and the SPA fallback are reachable surface sitting behind the same token
    // gate, so each is named here: neither may become a way to read the app without the cookie.
    const script = Object.keys(FIXTURE_ASSETS).find(
      (path) => path.startsWith("/assets/") && path.endsWith(".js"),
    );
    assert.ok(script, "the fixture carries no hashed script");

    for (const path of ["/", script, "/s/deep-link"]) {
      assert.equal((await fetch(`${running.url}${path}`)).status, 401, path);
    }
  });

  it("answers an unknown path with the Entry Document, but keeps /api and /assets honest", async () => {
    const deepLink = await get("/s/some-agent-session");
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get("content-type") ?? "", /text\/html/);
    const html = await deepLink.text();
    for (const path of FIXTURE_ICON_PATHS) assert.match(html, new RegExp(`href="${path.replace(".", "\\.")}"`), path);

    for (const path of ["/api/nope", "/assets/index-deadbeef.js"]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/, path);
    }
  });

  it("tells a client the default Scope and available backends", async () => {
    const config = (await (await get("/api/config")).json()) as { scope: string; backends: string[] };
    assert.equal(config.scope, "/tmp/scope");
    assert.ok(config.backends.includes("fake"));
  });
});

/**
 * A Session Host with no web client. `flow serve` refuses to reach this state — it builds first and
 * fails loudly if it cannot — but serve() is handed an empty manifest by every test that is about
 * the API rather than the UI, so the routing has to hold: the fallback stays a 404 instead of
 * reaching for an Entry Document that is not there.
 */
describe("a deployment with no web client", () => {
  it("404s the UI without disturbing the API", async () => {
    const host = new SessionHost();
    host.registerBackend(new FakeBackend());
    const running = await serve({ host, token: TOKEN, scope: "/tmp/scope", assets: {} });
    try {
      for (const path of ["/", "/s/deep-link", "/favicon.svg"]) {
        const response = await fetch(`${running.url}${path}`, { headers: { cookie: `flow=${TOKEN}` } });
        assert.equal(response.status, 404, path);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/, path);
      }

      const config = await fetch(`${running.url}/api/config`, { headers: { cookie: `flow=${TOKEN}` } });
      assert.equal(config.status, 200);
    } finally {
      await running.close();
    }
  });
});
