import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Duplex } from "node:stream";

/** Local TLS proxy: the installed CLI uses its real production OAuth code, but no request leaves
 * this fixture. No real credentials, certificate bypass, or credential-store mutation is needed. */
export async function claudeAuthFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "flow-claude-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), auth = join(home, ".claude"), scope = join(root, "scope");
  for (const path of [auth, scope]) mkdirSync(path, { recursive: true });
  const cert = join(root, "cert.pem"), key = join(root, "key.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=platform.claude.com",
    "-addext", "subjectAltName=DNS:platform.claude.com,DNS:api.anthropic.com,DNS:claude.ai"], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(`OAuth fixture requires openssl: ${generated.stderr}`);
  const scopes = ["user:inference", "user:profile", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
  const credentialsPath = join(auth, ".credentials.json");
  function expire(refreshToken = "fake-old-refresh") {
    writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "fake-old-access",
      refreshToken, expiresAt: Date.now() - 100_000, scopes, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }));
  }
  expire();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
    oauthAccount: { accountUuid: "fixture", emailAddress: "test@example.com", organizationUuid: "fixture",
      billingType: "stripe_subscription", accountCreatedAt: "2020-01-01", subscriptionCreatedAt: "2020-01-01" } }));
  const refreshTokens: string[] = [], authorization: string[] = [];
  let lockSeen = false;
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("oauth/token")) {
        refreshTokens.push(JSON.parse(body).refresh_token);
        // Hold the refresh long enough for concurrent workers to contend on the CLI's lock.
        try { lockSeen ||= readFileSync(join(auth, ".oauth_refresh.lock.owner"), "utf8").includes('"pid"'); } catch { /* restricted lock is private */ }
        setTimeout(() => res.end(JSON.stringify({ access_token: "fake-new-access", refresh_token: "fake-new-refresh",
          expires_in: 7200, scope: scopes.join(" ") })), 800);
      } else if (req.url?.startsWith("/v1/messages")) {
        authorization.push(String(req.headers.authorization));
        // A non-auth error closes the SDK turn without provoking forced OAuth retries.
        res.statusCode = 400;
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "local OAuth fixture: no model" } }));
      } else if (req.url?.startsWith("/api/oauth/profile")) {
        res.end(JSON.stringify({ account: { uuid: "fixture", email: "test@example.com" },
          organization: { uuid: "fixture", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } }));
      } else { res.end("{}"); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const connections = new Set<Duplex>();
  const proxy = http.createServer();
  proxy.on("connect", (_req, socket, head) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS fixture not listening");
    const target = net.connect(address.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target); target.pipe(socket);
    });
    for (const connection of [socket, target]) {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
    }
    target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const connection of connections) connection.destroy();
    server.closeAllConnections(); server.close(); proxy.close();
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("OAuth proxy not listening");
  const env: NodeJS.ProcessEnv = { HOME: home, CLAUDE_CONFIG_DIR: auth,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
    // Force the fake Anthropic OAuth route even when a developer normally uses a
    // cloud provider, an alternate API endpoint, or host-side credential helpers.
    CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined,
    ANTHROPIC_BASE_URL: undefined, ANTHROPIC_CUSTOM_HEADERS: undefined, CLAUDE_CODE_API_KEY_HELPER_TTL_MS: undefined,
    HTTPS_PROXY: `http://127.0.0.1:${address.port}`, HTTP_PROXY: `http://127.0.0.1:${address.port}`,
    https_proxy: `http://127.0.0.1:${address.port}`, http_proxy: `http://127.0.0.1:${address.port}`,
    ALL_PROXY: `http://127.0.0.1:${address.port}`, all_proxy: `http://127.0.0.1:${address.port}`,
    NO_PROXY: "", no_proxy: "", NODE_EXTRA_CA_CERTS: cert, DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  return { root, home, auth, scope, cert, env, refreshTokens, authorization, expire,
    lockSeen: () => lockSeen,
    credentials: () => JSON.parse(readFileSync(credentialsPath, "utf8")).claudeAiOauth,
    state: (name: string) => { const path = join(root, name, "backend"); mkdirSync(path, { recursive: true }); return path; } };
}
