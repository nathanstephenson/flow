import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import {
  OidcGate,
  oidcConfigFromEnv,
  type OidcConfig,
} from "../src/daemon/auth.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { startTestIssuer, type TestIssuer } from "./fixtures/oidc-issuer.ts";

const roots: string[] = [];
const issuers: TestIssuer[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(issuers.splice(0).map(async (issuer) => await issuer.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external OIDC browser gate", () => {
  it("is all-or-nothing, HTTPS-only away from localhost, and otherwise optional", () => {
    assert.equal(oidcConfigFromEnv({}), undefined);
    assert.throws(() => oidcConfigFromEnv({ FLOW_OIDC_ISSUER: "https://id.example" }), /configured together/);
    assert.throws(() => oidcConfigFromEnv({ FLOW_OIDC_ISSUER: "   " }), /configured together/);
    assert.throws(() => oidcConfigFromEnv({ ...envOf("https://id.example", "https://flow.example"), FLOW_OIDC_CLIENT_ID: " " }), /configured together/);
    assert.equal(oidcConfigFromEnv(envOf("https://id.example/", "https://flow.example"))?.issuer, "https://id.example/");
    assert.throws(() => oidcConfigFromEnv(envOf("http://id.example", "https://flow.example")), /HTTPS/);
    assert.throws(() => oidcConfigFromEnv(envOf("https://id.example", "http://flow.example")), /HTTPS/);
    assert.deepEqual(oidcConfigFromEnv(envOf("http://127.0.0.1:9000", "http://localhost:4318")), {
      issuer: "http://127.0.0.1:9000",
      clientId: "flow-test",
      clientSecret: "flow-test-secret",
      publicAppUrl: "http://localhost:4318",
    });
  });

  it("logs in with PKCE, restores a safe deep link, and keeps bearer clients independent", async () => {
    const context = await setup();

    const document = await fetch(`${context.server.url}/some/deep/path?tab=files`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(document.status, 200);
    const redirectPage = await document.text();
    assert.match(redirectPage, /location\.pathname\+location\.search\+location\.hash/);
    assert.match(redirectPage, /\/oauth\/login\?return_to=/);

    const unauthorized = await fetch(`${context.server.url}/api/sessions`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("x-flow-login"), "/oauth/login");

    const legacy = await fetch(`${context.server.url}/auth?token=bearer-secret`, { redirect: "manual" });
    assert.equal(legacy.status, 404, "OIDC mode must not mint the legacy flow cookie");
    const legacyCookie = await fetch(`${context.server.url}/api/sessions`, {
      headers: { cookie: "flow=bearer-secret" },
    });
    assert.equal(legacyCookie.status, 401);
    assert.equal((await fetch(`${context.server.url}/api/sessions`, {
      headers: { cookie: "flow_session=forged" },
    })).status, 401);
    assert.equal((await fetch(`${context.server.url}/api/sessions`, {
      headers: { authorization: "Bearer bearer-secret", origin: "https://evil.example" },
    })).status, 403, "OIDC does not weaken the origin gate for browser-shaped bearer requests");
    const staleCallback = await fetch(`${context.server.url}/oauth/callback?code=forged&state=forged`);
    assert.equal(staleCallback.status, 400);
    assert.doesNotMatch(await staleCallback.text(), /code=forged|state=forged/);

    const login = await browserLogin(context, "/some/deep/path?tab=files#/s/agent-1");
    assert.equal(login.location, "/some/deep/path?tab=files#/s/agent-1");
    assert.match(login.cookie, /^flow_session=/);
    assert.doesNotMatch(login.cookie, /access|refresh|eyJ/);
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);

    const bearer = await fetch(`${context.server.url}/api/sessions`, {
      headers: { authorization: "Bearer bearer-secret" },
    });
    assert.equal(bearer.status, 200, "explicit bearer access remains available in OIDC mode");

    const unsafe = await browserLogin(context, "https://evil.example/steal");
    assert.equal(unsafe.location, "/", "off-origin return targets must be discarded");
  });

  it("requests consent on every new login", async () => {
    const context = await setup();
    for (let index = 0; index < 2; index += 1) {
      const url = new URL(await context.gate.beginLogin("/"));
      assert.equal(url.searchParams.get("prompt"), "consent");
      assert.equal(url.searchParams.get("scope"), "openid offline_access");
    }
  });

  it("supports client_secret_post and query-bearing provider endpoints", async () => {
    const context = await setup({
      clientAuthentication: "client_secret_post",
      endpointQuery: "tenant=flow",
    });
    const login = await browserLogin(context, "/");
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);
  });

  it("persists opaque sessions across restart with private filesystem permissions", async () => {
    const context = await setup();
    const login = await browserLogin(context, "/");
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);

    const statePath = join(context.root, "oidc", "sessions.json");
    assert.equal((statSync(context.root).mode & 0o777).toString(8), "700");
    assert.equal((statSync(join(context.root, "oidc")).mode & 0o777).toString(8), "700");
    assert.equal((statSync(statePath).mode & 0o777).toString(8), "600");
    const stored = readFileSync(statePath, "utf8");
    assert.equal(
      (JSON.parse(stored) as { sessions: Array<{ id: string }> }).sessions[0]?.id,
      cookieToken(login.cookie),
      "the persisted record is addressed by the opaque browser credential",
    );
    assert.match(stored, /refreshToken/, "provider tokens remain server-side and durable");

    await context.server.close();
    servers.splice(servers.indexOf(context.server), 1);
    const gate = await OidcGate.create(context.config, context.root);
    const restarted = await serve({ host: new SessionHost(), token: "bearer-secret", oidc: gate, assets: {} });
    servers.push(restarted);
    context.server = restarted;
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);

    await restarted.close();
    servers.splice(servers.indexOf(restarted), 1);
    const changedGate = await OidcGate.create(
      { ...context.config, clientId: "flow-new-trust-domain" },
      context.root,
    );
    assert.equal(
      await changedGate.authenticate(login.cookie),
      undefined,
      "persisted sessions are bound to the configured issuer and client ID",
    );
    changedGate.dispose();

    const restoredGate = await OidcGate.create(context.config, context.root);
    const restoredServer = await serve({ host: new SessionHost(), token: "bearer-secret", oidc: restoredGate, assets: {} });
    servers.push(restoredServer);
    context.server = restoredServer;

    // The seven-day absolute deadline is authoritative after restart, not extended by activity.
    const value = JSON.parse(readFileSync(statePath, "utf8")) as { sessions: Array<{ expiresAt: number }> };
    value.sessions[0]!.expiresAt = Date.now() - 1;
    writeFileSync(statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await restoredServer.close();
    servers.splice(servers.indexOf(restoredServer), 1);
    const expiredGate = await OidcGate.create(context.config, context.root);
    const expiredServer = await serve({ host: new SessionHost(), token: "bearer-secret", oidc: expiredGate, assets: {} });
    servers.push(expiredServer);
    context.server = expiredServer;
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 401);
  });

  it("does not refresh every serial request when provider tokens are short-lived", async () => {
    const context = await setup({ expiresIn: 1 });
    const login = await browserLogin(context, "/");

    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await authed(context, login.cookie, "/api/sessions"));
    }
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(context.issuer.refreshRequests, 0);

    await waitFor(() => context.issuer.refreshRequests === 1);
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);
    }
    assert.equal(context.issuer.refreshRequests, 1);
  });

  it("invalidates the session after a failed refresh", async () => {

    const failed = await setup({ expiresIn: 1 });
    const failedLogin = await browserLogin(failed, "/");
    let idleClosed = false;
    failed.gate.registerConnection(cookieToken(failedLogin.cookie), () => { idleClosed = true; });
    failed.issuer.setFailRefresh(true);
    await waitFor(() => idleClosed);
    assert.equal(idleClosed, true, "a failed background refresh closes an idle connection");
    assert.equal((await authed(failed, failedLogin.cookie, "/api/sessions")).status, 401);
  });

  it("logout closes an idle event stream, preserves Agent Sessions, and leaves an explicit screen", async () => {
    const context = await setup();
    const login = await browserLogin(context, "/");
    const backend = new FakeBackend();
    context.host.registerBackend(backend);
    const sessionId = await context.host.create({ scope: "/tmp/oidc", backend: "fake" });
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);

    const stream = await fetch(`${context.server.url}/api/sessions/${sessionId}/events`, {
      headers: { cookie: login.cookie },
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    await reader.read(); // consume the replay, leaving the next read idle
    const ended = reader.read();

    const logout = await fetch(`${context.server.url}/oauth/logout`, {
      method: "POST",
      headers: { cookie: login.cookie, origin: context.config.publicAppUrl },
      redirect: "manual",
    });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get("location"), "/oauth/signed-out");
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(
      await streamFinished(reader, ended),
      true,
      "idle SSE transports associated with the browser session are closed",
    );
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 401);
    assert.equal(context.host.list().length, 1, "browser logout must not settle or end Agent Sessions");
    assert.equal(context.host.list()[0]?.id, sessionId);

    const signedOut = await fetch(`${context.server.url}/oauth/signed-out`);
    assert.equal(signedOut.status, 200);
    assert.match(await signedOut.text(), /You’re signed out/);

    const crossOrigin = await fetch(`${context.server.url}/oauth/logout`, {
      method: "POST",
      headers: { cookie: login.cookie, origin: "https://evil.example" },
    });
    assert.equal(crossOrigin.status, 403);
  });

  it("accepts signed back-channel logout once, rejects tampering and replay, and revokes sid immediately", async () => {
    const context = await setup();
    const login = await browserLogin(context, "/");
    let closed = false;
    context.gate.registerConnection(cookieToken(login.cookie), () => { closed = true; });

    const tampered = `${context.issuer.logoutToken({ sid: context.issuer.providerSid })}x`;
    assert.equal((await backchannel(context, tampered)).status, 400);
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 200);

    assert.equal((await backchannel(context, context.issuer.logoutToken({
      sub: "someone-else",
      jti: null,
    }))).status, 400, "logout tokens require jti");
    assert.equal((await backchannel(context, context.issuer.logoutToken({
      sub: "someone-else",
      jti: "",
    }))).status, 400, "logout token jti must be a non-empty string");
    assert.equal((await backchannel(context, context.issuer.logoutToken({
      sub: "someone-else",
      exp: null,
    }))).status, 400, "logout tokens require exp");

    assert.equal((await backchannel(context, context.issuer.logoutToken({
      sub: "someone-else",
      event: { provider_extension: true },
    }))).status, 200, "event objects may contain extension members");

    const now = Math.floor(Date.now() / 1_000);
    assert.equal((await backchannel(context, context.issuer.logoutToken({
      sub: "someone-else",
      issuedAt: now - 700,
    }))).status, 400, "stale logout tokens are rejected");
    assert.equal((await backchannel(context, context.issuer.logoutToken({
      sub: "someone-else",
      issuedAt: now + 120,
    }))).status, 400, "future-issued logout tokens are rejected");

    const token = context.issuer.logoutToken({ sid: context.issuer.providerSid, jti: "once" });
    assert.equal((await backchannel(context, token)).status, 200);
    assert.equal(closed, true);
    let lateConnectionClosed = false;
    context.gate.registerConnection(cookieToken(login.cookie), () => { lateConnectionClosed = true; });
    assert.equal(lateConnectionClosed, true, "registration cannot revive a session revoked during setup");
    assert.equal((await authed(context, login.cookie, "/api/sessions")).status, 401);
    assert.equal((await backchannel(context, token)).status, 400, "logout notifications cannot be replayed");
    const reusedJti = context.issuer.logoutToken({ sub: context.issuer.subject, jti: "once" });
    assert.equal((await backchannel(context, reusedJti)).status, 400, "a jti cannot be reused in a new token");

    const wrongIssuer = context.issuer.logoutToken({ sub: context.issuer.subject, issuer: "https://evil.example" });
    assert.equal((await backchannel(context, wrongIssuer)).status, 400);
  });
});

type Context = {
  root: string;
  issuer: TestIssuer;
  config: OidcConfig;
  gate: OidcGate;
  server: RunningServer;
  host: SessionHost;
};

async function setup(options: {
  expiresIn?: number;
  endpointQuery?: string;
  clientAuthentication?: "client_secret_basic" | "client_secret_post";
} = {}): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), "flow-oidc-"));
  roots.push(root);
  const issuer = await startTestIssuer(options);
  issuers.push(issuer);
  const config: OidcConfig = {
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
    // It need not equal the direct test socket; a reverse proxy would make the same distinction.
    publicAppUrl: "http://127.0.0.1:4318",
  };
  const gate = await OidcGate.create(config, root);
  const host = new SessionHost();
  const server = await serve({ host, token: "bearer-secret", oidc: gate, assets: {} });
  servers.push(server);
  return { root, issuer, config, gate, server, host };
}

async function browserLogin(context: Context, returnTo: string): Promise<{ cookie: string; location: string }> {
  const start = await fetch(
    `${context.server.url}/oauth/login?return_to=${encodeURIComponent(returnTo)}`,
    { redirect: "manual" },
  );
  assert.equal(start.status, 302);
  const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const providerCallback = new URL(authorize.headers.get("location")!);
  const callback = await fetch(
    `${context.server.url}${providerCallback.pathname}${providerCallback.search}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 302, await callback.text());
  return {
    cookie: (callback.headers.get("set-cookie") ?? "").split(";")[0]!,
    location: callback.headers.get("location") ?? "",
  };
}

async function authed(context: Context, cookie: string, path: string): Promise<Response> {
  return await fetch(`${context.server.url}${path}`, { headers: { cookie } });
}

async function backchannel(context: Context, token: string): Promise<Response> {
  return await fetch(`${context.server.url}/oauth/backchannel`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ logout_token: token }),
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_500): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for OIDC state change");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function streamFinished(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: Promise<{ done: boolean }>,
): Promise<boolean> {
  const readToEnd = async (): Promise<boolean> => {
    let result = await first;
    while (!result.done) result = await reader.read();
    return true;
  };
  return await Promise.race([
    readToEnd(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
}

function cookieToken(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function envOf(issuer: string, publicAppUrl: string): NodeJS.ProcessEnv {
  return {
    FLOW_OIDC_ISSUER: issuer,
    FLOW_OIDC_CLIENT_ID: "flow-test",
    FLOW_OIDC_CLIENT_SECRET: "flow-test-secret",
    FLOW_OIDC_PUBLIC_APP_URL: publicAppUrl,
  };
}
