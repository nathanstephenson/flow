import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpSession } from "../src/backend/mcp.ts";
import { SessionHost } from "../src/daemon/host.ts";
import type { McpConnection } from "../src/protocol/mcp.ts";

test("configured headers reach the server, resolved from Secrets", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-headers-"));
  let seen: Record<string, string | string[] | undefined> = {};
  const server = createServer((request, response) => {
    if (new URL(request.url!, "http://127.0.0.1").pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    seen = request.headers;
    const mcp = new McpServer({ name: "header-fixture", version: "1" });
    mcp.registerTool("hello", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "remote" }] }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport)
      .then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const connection: McpConnection = {
    id: "remote",
    name: "Remote",
    enabledByDefault: true,
    transport: "http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    oauth: false,
    headers: { Authorization: { secret: "linear_token" }, "X-Tenant-Id": { value: "acme" } },
  };
  const resolveSecret = (name: string) => {
    if (name !== "linear_token") throw new Error("Unknown secret");
    return "Bearer from-the-secret-store";
  };
  try {
    const session = new McpSession([connection], root, undefined, false, resolveSecret);
    await session.open();
    assert.equal(session.status()[0]?.state, "connected");
    assert.equal(seen.authorization, "Bearer from-the-secret-store");
    assert.equal(seen["x-tenant-id"], "acme");

    // A header naming a Secret that has gone missing must fail the connection rather than talk to
    // the server without it.
    seen = {};
    const missing = new McpSession(
      [{ ...connection, headers: { Authorization: { secret: "removed" } } }],
      root,
      undefined,
      false,
      resolveSecret,
    );
    await missing.open();
    assert.equal(missing.status()[0]?.state, "failed");
    assert.deepEqual(seen, {});
    await session.dispose();
    await missing.dispose();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a secret-backed header is always redacted, a literal one only when its name reads as a credential", () => {
  const connection: McpConnection = {
    id: "remote",
    name: "Remote",
    enabledByDefault: true,
    transport: "http",
    url: "https://example.test/mcp",
    oauth: false,
    headers: {
      Authorization: { secret: "linear_token" },
      "X-Api-Key": { value: "literal-key" },
      "X-Tenant-Id": { value: "acme" },
    },
  };
  const host = new SessionHost({
    mcpConnections: () => [connection],
    resolveSecret: () => "resolved-token",
  });
  const values = host.workflowMcpCredentials();
  assert.ok(values.includes("resolved-token"));
  assert.ok(values.includes("literal-key"));
  assert.ok(!values.includes("acme"));
});
