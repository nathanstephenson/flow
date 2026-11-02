import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpSession } from "../../src/backend/mcp.ts";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { SandboxMcpSession } from "../../src/backend/worker/sandbox-mcp.ts";
import type { McpConnection } from "../../src/protocol/mcp.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { fakeProvider } from "./sandbox-fixture.ts";

const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;

test("an OAuth connection asks the host for a refreshed token after a 401 and retries once", async (t) => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fresh") { response.writeHead(401).end(); return; }
    const mcp = new McpServer({ name: "remote", version: "1" });
    mcp.registerTool("hello", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "hi" }] }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport).then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let current = "stale";
  const requests: boolean[] = [];
  const session = new McpSession([{ id: "remote", name: "Remote", transport: "http", enabledByDefault: true,
    url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, oauth: true }], "/", undefined, false, undefined, undefined, undefined, "none", undefined,
  async (_id, refresh) => { requests.push(refresh); if (refresh) current = "fresh"; return current; });
  t.after(() => session.dispose());
  await session.open();
  assert.deepEqual(session.status(), [{ id: "remote", state: "connected", tools: 1 }]);
  assert.equal(requests.filter(Boolean).length, 1);
  assert.deepEqual((await session.tools()[0]!.call({})).content, [{ type: "text", text: "hi" }]);
});

test("the host gives the worker only access tokens and refuses unknown or signed-out connections", async () => {
  const connection: McpConnection = { id: "remote", name: "Remote", transport: "http", enabledByDefault: true,
    url: "https://mcp.example.com/mcp", headers: { "X-Tenant": { secret: "TENANT" } }, oauth: true };
  let tokens: { access_token: string; token_type: string; refresh_token?: string } | undefined = { access_token: "a", token_type: "bearer", refresh_token: "r" };
  const provider = { tokens: async () => tokens } as unknown as OAuthClientProvider;
  const mcp = new SandboxMcpSession([connection], "/", () => provider, (name) => `secret:${name}`);
  assert.equal(await mcp.token("remote", false), "a");
  await assert.rejects(mcp.token("other", false), /Unknown MCP connection/);
  tokens = undefined;
  await assert.rejects(mcp.token("remote", false), /sign-in required/);
  assert.deepEqual(mcp.definitions()[0], { ...connection, headers: { "X-Tenant": { value: "secret:TENANT" } } });
});

test("a sandbox Backend Session runs its MCP clients and tool calls in the worker", async (t) => {
  const f = fakeProvider(t);
  const connection: McpConnection = { id: "fixture", name: "Fixture", transport: "stdio", enabledByDefault: true,
    command: process.execPath, args: ["--experimental-strip-types", resolve("test/fixtures/mcp-server.ts")] };
  const mcp = new SandboxMcpSession([connection], f.scope);
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, mcp, emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  await mcp.open();
  assert.deepEqual(mcp.status(), [{ id: "fixture", state: "connected", tools: 2 }]);
  assert.deepEqual(mcp.tools(), []);
  await session.prompt("mcp");
  const event = events.find((entry) => entry.type === "message" && entry.id === "mcp");
  assert.ok(event?.type === "message");
  assert.match(event.text, /content/);
  await mcp.retry("fixture");
  assert.equal(mcp.status()[0]?.state, "connected");
});
