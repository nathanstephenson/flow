import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpSession } from "../../src/backend/mcp.ts";
import { claudeMcpServers, refreshClaudeMcp } from "../../src/backend/claude/mcp.ts";
import { workflowParentServer } from "../../src/backend/claude/workflow-parent.ts";
import { prepareFilesystemIsolation } from "../../src/isolation/filesystem.ts";

test("Claude registration waits for startup and can retry a rejected registration", async () => {
  const mcp = new McpSession([{ id: "fixture", name: "Fixture", enabledByDefault: true,
    transport: "stdio", command: process.execPath, args: [] }], tmpdir());
  let statusReads = 0;
  let additions = 0;
  const stream: Pick<Query, "setMcpServers" | "mcpServerStatus"> = {
    async mcpServerStatus() {
      statusReads++;
      if (statusReads === 1) return [];
      return [{ name: "fixture", status: statusReads === 2 ? "pending" : statusReads === 3 ? "failed" : "connected" }];
    },
    async setMcpServers(servers) {
      assert.ok(statusReads >= 3, "startup must settle before removal");
      if (!Object.keys(servers).length) return { added: [], removed: ["fixture"], errors: {} };
      additions++;
      return { added: [], removed: [], errors: additions === 1 ? { fixture: "rejected" } : {} };
    },
  };
  await assert.rejects(refreshClaudeMcp(stream, mcp), /MCP tools could not be registered/);
  await refreshClaudeMcp(stream, mcp);
  assert.equal(additions, 2);
  assert.equal(statusReads, 4);
});

test("a failed external MCP refresh restores the parent workflow tools", async () => {
  const mcp = new McpSession([{ id: "fixture", name: "Fixture", enabledByDefault: true,
    transport: "stdio", command: process.execPath, args: [] }], tmpdir());
  const workflow = workflowParentServer({ inspect: async () => ({}), recover: async () => ({}),
    relayEnquiry: async () => ({}), relayPermission: async () => ({}) });
  const calls: string[][] = [];
  const stream: Pick<Query, "setMcpServers" | "mcpServerStatus"> = {
    async mcpServerStatus() {
      return [{ name: "fixture", status: "failed" }, { name: "flow_workflow", status: "connected" }];
    },
    async setMcpServers(servers) {
      calls.push(Object.keys(servers).sort());
      return { added: [], removed: [], errors: "fixture" in servers ? { fixture: "offline" } : {} };
    },
  };
  await assert.rejects(refreshClaudeMcp(stream, mcp, workflow), /MCP tools could not be registered/);
  assert.deepEqual(calls, [[], ["fixture", "flow_workflow"], ["flow_workflow"]]);
});

test("real Claude SDK refreshes tools after delayed discovery and Retry without a model request", { timeout: 30_000 }, async (t) => {
  try {
    (await prepareFilesystemIsolation({ scope: process.cwd(), command: process.execPath, args: [], credentials: "none" })).cleanup();
  } catch (error) { t.skip(`Filesystem isolation unavailable: ${(error as Error).message}`); return; }
  const scope = await mkdtemp(join(tmpdir(), "flow-claude-mcp-"));
  const mcp = new McpSession([{ id: "fixture", name: "Fixture", enabledByDefault: true,
    transport: "stdio", command: process.execPath, args: ["--experimental-strip-types", resolve("test/fixtures/mcp-server.ts")] }], scope);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const servers = claudeMcpServers(mcp);
  const workflow = workflowParentServer({ inspect: async () => ({}), recover: async () => ({}),
    relayEnquiry: async () => ({}), relayPermission: async () => ({}) });
  let initialListingComplete = false;
  servers.fixture!.instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    initialListingComplete = true;
    return { tools: [] };
  });
  const stream = query({ prompt: (async function* () { await waiting; })(), options: {
    cwd: scope, settingSources: [], mcpServers: { ...servers, ...workflow }, tools: [],
    env: { ...process.env, HOME: scope, CLAUDE_CONFIG_DIR: scope,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "dummy-local-key",
      ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined },
  } });
  try {
    const tools = async () => (await stream.mcpServerStatus()).find((server) => server.name === "fixture")?.tools?.map((tool) => tool.name).sort() ?? [];
    const relayAvailable = async () => (await stream.mcpServerStatus()).find((server) => server.name === "flow_workflow")?.tools?.some((tool) => tool.name === "workflow_relay_enquiry") ?? false;
    await refreshClaudeMcp({
      mcpServerStatus: () => stream.mcpServerStatus(),
      setMcpServers: (servers) => {
        assert.equal(initialListingComplete, true, "startup tool listing must finish before removal");
        return stream.setMcpServers(servers);
      },
    }, mcp, workflow);
    assert.deepEqual(await tools(), []);
    assert.equal(await relayAvailable(), true);
    await mcp.open();
    assert.equal(mcp.tools().length, 2);
    await refreshClaudeMcp(stream, mcp, workflow);
    assert.deepEqual(await tools(), ["echo", "fail"]);
    assert.equal(await relayAvailable(), true);
    await mcp.retry("fixture");
    await refreshClaudeMcp(stream, mcp, workflow);
    assert.deepEqual(await tools(), ["echo", "fail"]);
    assert.equal(await relayAvailable(), true);
  } finally {
    finish();
    stream.close();
    await mcp.dispose();
    await rm(scope, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
