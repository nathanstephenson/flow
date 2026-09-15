import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpSession } from "../src/backend/mcp.ts";
import { McpAuth } from "../src/daemon/mcp-auth.ts";

test(
  "remote HTTP MCP uses OAuth discovery, PKCE callback, and private shared tokens",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-mcp-http-"));
    let base = "";
    let verifier = "";
    let accessToken = "machine-identity";
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
      enabledByDefault: true,
    };
    const auth = new McpAuth(root);
    const runtime = new McpSession([connection], root, (connection) =>
      auth.provider(connection),
    );
    try {
      await runtime.open();
      assert.equal(runtime.status()[0]?.state, "failed");
      const authorization = new URL(await auth.login(connection));
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", "wrong");
      callback.searchParams.set("code", "code");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      assert.equal((await fetch(callback)).status, 200);
      assert.ok(verifier.length >= 43);
      await runtime.retry("remote");
      assert.equal(runtime.status()[0]?.state, "connected");
      assert.deepEqual((await runtime.tools()[0]!.call({})).content, [
        { type: "text", text: "remote" },
      ]);
      accessToken = "refreshed-identity";
      assert.deepEqual((await runtime.tools()[0]!.call({})).content, [{ type: "text", text: "remote" }]);
      assert.equal((await auth.provider(connection).tokens())?.access_token, accessToken);
    } finally {
      auth.dispose();
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
