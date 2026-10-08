import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auth as authorize } from "@modelcontextprotocol/sdk/client/auth.js";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAuth } from "../src/daemon/mcp-auth.ts";
import { ConfigStore } from "../src/daemon/config-store.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve } from "../src/daemon/server.ts";
import type { McpConnection } from "../src/protocol/mcp.ts";
import { FIXTURE_ASSETS } from "./assets-fixture.ts";

const remote = {
  id: "remote", name: "Remote", transport: "http" as const,
  url: "https://example.test/mcp", oauth: true, headers: {}, enabledByDefault: true,
};
const tokens = { access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", expires_in: 0 };
const client = { client_id: "private-client", client_secret: "private-client-secret" };

async function fixture(connections: McpConnection[]) {
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-auth-"));
  const auth = new McpAuth(root);
  const config = new ConfigStore(root);
  config.update({ mcp: connections });
  const host = new SessionHost();
  const flow = await serve({ host, config, mcpAuth: auth, token: "test-token", assets: FIXTURE_ASSETS });
  return {
    root, auth, config, host, flow,
    request: (path: string, method = "GET", headers: Record<string, string> = { authorization: "Bearer test-token" }) =>
      fetch(`${flow.url}/api/mcp/${path}`, { method, headers }),
    close: async () => {
      await flow.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("MCP auth status lists only configured OAuth access tokens without credentials, including expired tokens", async () => {
  const registration = { ...remote, id: "registration" };
  const staticConnection = { ...remote, id: "static", oauth: false };
  const local: McpConnection = { id: "local", name: "Local", transport: "stdio", command: "true", args: [], enabledByDefault: true };
  const changed = { ...remote, id: "changed", url: "https://changed.test/mcp" };
  const f = await fixture([remote, registration, staticConnection, local, changed]);
  try {
    assert.deepEqual(await (await f.request("auth")).json(), { signedIn: [] });
    await f.auth.provider(remote).saveClientInformation!(client);
    await f.auth.provider(remote).saveTokens(tokens);
    await f.auth.provider(registration).saveClientInformation!(client);
    for (const connection of [staticConnection, local, { ...remote, id: "removed" }, { ...changed, url: remote.url }])
      await f.auth.provider(connection).saveTokens(tokens);
    const response = await f.request("auth");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { signedIn: [remote.id] });
    f.config.update({ mcp: [registration] });
    assert.deepEqual(await (await f.request("auth")).json(), { signedIn: [] });
  } finally { await f.close(); }
});

test("MCP logout removes only the selected connection and endpoint and persists a private file", async () => {
  const other = { ...remote, id: "other" };
  const oldEndpoint = { ...remote, url: "https://old.test/mcp" };
  const f = await fixture([remote, other]);
  try {
    for (const connection of [remote, other, oldEndpoint]) {
      await f.auth.provider(connection).saveClientInformation!(client);
      await f.auth.provider(connection).saveTokens(tokens);
    }
    assert.equal((await f.request("remote/logout", "POST")).status, 200);
    assert.deepEqual(await (await f.request("auth")).json(), { signedIn: [other.id] });
    const restored = new McpAuth(f.root);
    assert.equal(await restored.provider(remote).tokens(), undefined);
    assert.equal(await restored.provider(remote).clientInformation(), undefined);
    for (const connection of [other, oldEndpoint]) {
      assert.deepEqual(await restored.provider(connection).tokens(), tokens);
      assert.deepEqual(await restored.provider(connection).clientInformation(), client);
    }
    assert.equal(Object.keys(JSON.parse(readFileSync(join(f.root, "mcp-credentials.json"), "utf8"))).length, 2);
    assert.equal(statSync(join(f.root, "mcp-credentials.json")).mode & 0o777, 0o600);
    assert.equal((await f.request("remote/logout", "POST")).status, 200);
  } finally { await f.close(); }
});

test("MCP auth routes enforce authentication, origin, methods, and OAuth connection IDs", async () => {
  const local: McpConnection = { id: "local", name: "Local", transport: "stdio", command: "true", args: [], enabledByDefault: true };
  const f = await fixture([remote, { ...remote, id: "static", oauth: false }, local]);
  try {
    await f.auth.provider(remote).saveTokens(tokens);
    for (const [path, method] of [["auth", "GET"], ["remote/logout", "POST"]]) {
      for (const headers of [{}, { authorization: "Bearer wrong" }, { cookie: "flow=wrong" }])
        assert.equal((await f.request(path!, method, headers)).status, 401);
      assert.equal((await f.request(path!, method, { authorization: "Bearer test-token", origin: "https://attacker.test" })).status, 403);
    }
    for (const method of ["POST", "PUT", "DELETE"])
      assert.equal((await f.request("auth", method)).status, 405);
    for (const method of ["GET", "PUT", "DELETE"])
      assert.equal((await f.request("remote/logout", method)).status, 405);
    for (const id of ["missing", "static", "local"])
      assert.equal((await f.request(`${id}/logout`, "POST")).status, 400);
    assert.deepEqual(await f.auth.provider(remote).tokens(), tokens);
    assert.equal((await f.request("auth", "GET", { cookie: "flow=test-token" })).status, 200);
    assert.equal((await f.request("remote/logout", "POST", { cookie: "flow=test-token" })).status, 200);
    assert.equal(await f.auth.provider(remote).tokens(), undefined);
  } finally { await f.close(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function oauthServer() {
  let base = "";
  let hold: "register" | "token" | undefined;
  let arrived = deferred<void>();
  let released = deferred<void>();
  const paths: string[] = [];
  const grants: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, base).pathname;
    paths.push(path);
    const json = (value: unknown, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (path.startsWith("/.well-known/oauth-protected-resource"))
      return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (path === "/.well-known/oauth-authorization-server")
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (path === "/register" || path === "/token") {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (path === `/${hold}`) {
        hold = undefined;
        arrived.resolve();
        await released.promise;
      }
      if (path === "/register") return json({ ...JSON.parse(body), ...client }, 201);
      grants.push(new URLSearchParams(body).get("grant_type")!);
      return json(tokens);
    }
    return json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  return {
    connection: { ...remote, url: `${base}/mcp` }, paths, grants,
    block: (endpoint: "register" | "token") => {
      hold = endpoint;
      arrived = deferred<void>();
      released = deferred<void>();
      return { arrived: arrived.promise, release: () => released.resolve() };
    },
    close: async () => {
      released.resolve();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function callback(authorization: string) {
  const url = new URL(authorization);
  const result = new URL(url.searchParams.get("redirect_uri")!);
  result.searchParams.set("state", url.searchParams.get("state")!);
  result.searchParams.set("code", "code");
  return result;
}

test("MCP logout cancels pending sign-ins across endpoints without cancelling another connection", { timeout: 15_000 }, async () => {
  const oauth = await oauthServer();
  const other = { ...oauth.connection, id: "other" };
  const f = await fixture([oauth.connection, other]);
  try {
    const cancelled = callback(await f.auth.login(oauth.connection, f.flow.url));
    const kept = callback(await f.auth.login(other, f.flow.url));
    f.config.update({ mcp: [{ ...oauth.connection, url: "https://changed.test/mcp" }, other] });
    assert.equal((await f.request("remote/logout", "POST")).status, 200);
    await assert.rejects(f.auth.callback(cancelled), /Invalid or expired/);
    assert.match(await f.auth.callback(kept), /mcpAuth=signed-in/);
    assert.equal(await f.auth.provider(oauth.connection).tokens(), undefined);
    assert.equal((await f.auth.provider(other).tokens())?.access_token, tokens.access_token);
    assert.deepEqual(await (await f.request("auth")).json(), { signedIn: [other.id] });
    assert.equal(await authorize(f.auth.provider(other), { serverUrl: other.url }), "AUTHORIZED");
    assert.equal(oauth.grants.at(-1), "refresh_token");
    assert.ok(!oauth.paths.includes("/revoke"));
  } finally { await f.close(); await oauth.close(); }
});

test("MCP logout prevents an in-flight callback from restoring credentials and allows a new sign-in", { timeout: 15_000 }, async () => {
  const oauth = await oauthServer();
  const f = await fixture([oauth.connection]);
  const blocked = oauth.block("token");
  try {
    const old = callback(await f.auth.login(oauth.connection, f.flow.url));
    const completing = f.auth.callback(old);
    await blocked.arrived;
    assert.equal((await f.request("remote/logout", "POST")).status, 200);
    const fresh = callback(await f.auth.login(oauth.connection, f.flow.url));
    blocked.release();
    assert.match(await completing, /mcpAuth=failed/);
    assert.equal(await f.auth.provider(oauth.connection).tokens(), undefined);
    assert.equal(await new McpAuth(f.root).provider(oauth.connection).clientInformation(), undefined);
    await assert.rejects(f.auth.callback(old), /Invalid or expired/);
    assert.match(await f.auth.callback(fresh), /mcpAuth=signed-in/);
    assert.equal((await new McpAuth(f.root).provider(oauth.connection).tokens())?.access_token, tokens.access_token);
  } finally { blocked.release(); await f.close(); await oauth.close(); }
});

test("MCP logout prevents an in-flight token refresh from restoring credentials", { timeout: 15_000 }, async () => {
  const oauth = await oauthServer();
  const f = await fixture([oauth.connection]);
  const blocked = oauth.block("token");
  try {
    const provider = f.auth.provider(oauth.connection);
    await provider.saveClientInformation!(client);
    await provider.saveTokens({ ...tokens, issuer: new URL(oauth.connection.url).origin });
    const refreshing = authorize(provider, { serverUrl: oauth.connection.url });
    void refreshing.catch(() => {});
    await blocked.arrived;
    assert.equal((await f.request("remote/logout", "POST")).status, 200);
    blocked.release();
    await refreshing.catch(() => {});
    assert.equal(await f.auth.provider(oauth.connection).tokens(), undefined);
    assert.equal(await new McpAuth(f.root).provider(oauth.connection).clientInformation(), undefined);
  } finally { blocked.release(); await f.close(); await oauth.close(); }
});

test("MCP logout cancels sign-in while client registration is in flight", { timeout: 15_000 }, async () => {
  const oauth = await oauthServer();
  const f = await fixture([oauth.connection]);
  const blocked = oauth.block("register");
  try {
    const starting = f.auth.login(oauth.connection, f.flow.url);
    void starting.catch(() => {});
    await blocked.arrived;
    assert.equal((await f.request("remote/logout", "POST")).status, 200);
    blocked.release();
    await assert.rejects(starting, /cancelled|expired/i);
    assert.equal(await new McpAuth(f.root).provider(oauth.connection).clientInformation(), undefined);
    assert.deepEqual(await (await f.request("auth")).json(), { signedIn: [] });
  } finally { blocked.release(); await f.close(); await oauth.close(); }
});
