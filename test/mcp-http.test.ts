import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpSession } from "../src/backend/mcp.ts";
import { McpAuth } from "../src/daemon/mcp-auth.ts";
import { ConfigStore } from "../src/daemon/config-store.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve } from "../src/daemon/server.ts";
import { FIXTURE_ASSETS, FIXTURE_ICON_PATHS } from "./assets-fixture.ts";

test(
  "remote HTTP MCP uses OAuth discovery, PKCE callback, and private shared tokens",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-mcp-http-"));
    let base = "";
    let verifier = "";
    let accessToken = "machine-identity";
    let tokenFailure = false;
    const server = createServer((request, response) => {
      const path = new URL(request.url!, base).pathname;
      const json = (value: unknown, status = 200) => {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      };
      if (path === "/.well-known/oauth-protected-resource")
        return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server")
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (path === "/register" || path === "/token") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          if (path === "/register")
            json({ ...JSON.parse(body), client_id: "flow-client" }, 201);
          else {
            if (tokenFailure) return json({ error: "invalid_grant" }, 400);
            verifier = new URLSearchParams(body).get("code_verifier") ?? "";
            json({
              access_token: accessToken,
              token_type: "Bearer",
              refresh_token: "refresh",
              expires_in: 3600,
            });
          }
        });
        return;
      }
      if (path === "/mcp") {
        if (request.headers.authorization !== `Bearer ${accessToken}`) {
          response
            .writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            })
            .end();
          return;
        }
        const mcp = new McpServer({ name: "http-fixture", version: "1" });
        mcp.registerTool("hello", { inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "remote" }],
        }));
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        response.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        void mcp
          .connect(
            transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
          )
          .then(() => transport.handleRequest(request, response));
        return;
      }
      json({}, 404);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    const connection = {
      id: "remote",
      name: "Remote",
      transport: "http" as const,
      url: `${base}/mcp`,
      oauth: true,
      headers: {},
      enabledByDefault: true,
    };
    const auth = new McpAuth(root);
    const config = new ConfigStore(root);
    config.update({ mcp: [connection] });
    const host = new SessionHost();
    const flow = await serve({ host, config, mcpAuth: auth, token: "test-token", assets: FIXTURE_ASSETS });
    const runtime = new McpSession([connection], root, (connection) =>
      auth.provider(connection),
    );
    try {
      await runtime.open();
      assert.equal(runtime.status()[0]?.state, "failed");
      const returnUrl = "https://flow.example:8443/settings/mcp?tab=connections#remote";
      const authorization = new URL(await auth.login(connection, returnUrl));
      await assert.rejects(auth.login(connection, returnUrl), /already in progress/);
      assert.equal(authorization.searchParams.get("redirect_uri"), "https://flow.example:8443/api/mcp/callback");
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", "wrong");
      callback.searchParams.set("code", "code");
      await assert.rejects(auth.callback(callback), /Invalid or expired/);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      const completing = auth.callback(callback);
      await assert.rejects(auth.login(connection, returnUrl), /already in progress/);
      await assert.rejects(auth.callback(callback), /Invalid or expired/);
      assert.equal(await completing, "https://flow.example:8443/settings/mcp?tab=connections&mcpAuth=signed-in#remote");
      await assert.rejects(auth.callback(callback), /Invalid or expired/);
      assert.ok(verifier.length >= 43);
      await runtime.retry("remote");
      assert.equal(runtime.status()[0]?.state, "connected");
      assert.deepEqual((await runtime.tools()[0]!.call({})).content, [
        { type: "text", text: "remote" },
      ]);
      accessToken = "refreshed-identity";
      assert.deepEqual((await runtime.tools()[0]!.call({})).content, [{ type: "text", text: "remote" }]);
      assert.equal((await auth.provider(connection).tokens())?.access_token, accessToken);
      // OAuth outranks a configured Authorization header: the fixture answers 401 to anything but
      // the issued token, so connecting at all proves the header did not win.
      const overridden = new McpSession(
        [{ ...connection, headers: { Authorization: { value: "Bearer wrong" } } }],
        root,
        (connection) => auth.provider(connection),
      );
      await overridden.open();
      assert.equal(overridden.status()[0]?.state, "connected");
      await overridden.dispose();
      const denied = new URL(await auth.login(connection, "https://flow.example/agent-sessions/example"));
      const deniedCallback = new URL(denied.searchParams.get("redirect_uri")!);
      deniedCallback.searchParams.set("state", denied.searchParams.get("state")!);
      deniedCallback.searchParams.set("error", "access_denied");
      assert.equal(await auth.callback(deniedCallback), "https://flow.example/agent-sessions/example?mcpAuth=failed");
      assert.equal((await auth.provider(connection).tokens())?.access_token, accessToken);
      for (const path of ["/#/settings/mcp", "/#/s/example"]) {
        const returnUrl = `${flow.url}${path}`;
        const login = (target: string, authenticated = true) => fetch(`${flow.url}/api/mcp/remote/login`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: flow.url, ...(authenticated ? { authorization: "Bearer test-token" } : {}) },
          body: JSON.stringify({ returnUrl: target }),
        });
        assert.equal((await login(returnUrl, false)).status, 401);
        assert.equal((await login("https://attacker.example/")).status, 400);
        const response = await login(returnUrl);
        assert.equal(response.status, 200);
        const authorization = new URL(((await response.json()) as { url: string }).url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        assert.equal(callback.origin, flow.url);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "code");
        const completed = await fetch(callback);
        assert.equal(completed.status, 200);
        assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
        const destination = new URL(returnUrl);
        destination.searchParams.set("mcpAuth", "signed-in");
        const returnPage = await completed.text();
        assert.ok(returnPage.includes(JSON.stringify(destination.href)));
        for (const path of FIXTURE_ICON_PATHS) {
          assert.match(returnPage, new RegExp(`href="${path.replace(".", "\\.")}"`), path);
        }
        assert.match(completed.headers.get("content-security-policy") ?? "", /img-src 'self'/);
        assert.doesNotMatch(returnPage, /state=|code=/, "callback parameters must not enter auth HTML or icon URLs");
        assert.equal((await fetch(callback)).status, 400);
      }
      const remoteLogin = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest(`${flow.url}/api/mcp/remote/login`, {
          method: "POST",
          headers: { host: "flow.example:8443", origin: "https://flow.example:8443", authorization: "Bearer test-token", "content-type": "application/json" },
        }, (response) => {
          let body = "";
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        request.on("error", reject);
        request.end(JSON.stringify({ returnUrl: "https://flow.example:8443/#/settings/mcp" }));
      });
      assert.equal(remoteLogin.status, 200);
      const remoteAuthorization = new URL(JSON.parse(remoteLogin.body).url);
      assert.equal(remoteAuthorization.searchParams.get("redirect_uri"), "https://flow.example:8443/api/mcp/callback");
      remoteAuthorization.searchParams.set("error", "access_denied");
      await auth.callback(remoteAuthorization);
      assert.equal(host.list().length, 0);
      tokenFailure = true;
      const failed = new URL(await auth.login(connection, "https://flow.example/#/settings/mcp"));
      const failedCallback = new URL(failed.searchParams.get("redirect_uri")!);
      failedCallback.searchParams.set("state", failed.searchParams.get("state")!);
      failedCallback.searchParams.set("code", "bad-code");
      assert.equal(await auth.callback(failedCallback), "https://flow.example/?mcpAuth=failed#/settings/mcp");
      assert.equal((await auth.provider(connection).tokens())?.access_token, accessToken);
      const abandoned = new URL(await auth.login(connection, "https://flow.example/"));
      auth.dispose();
      await assert.rejects(auth.callback(abandoned), /Invalid or expired/);
      await assert.rejects(auth.login(connection, "javascript:alert(1)"), /Invalid return URL/);
    } finally {
      await flow.close();
      auth.dispose();
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
