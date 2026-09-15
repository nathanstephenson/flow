import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpSession } from "../../src/backend/mcp.ts";
import { claudeMcpServers, refreshClaudeMcp } from "../../src/backend/claude/mcp.ts";

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

test("real Claude SDK refreshes tools after delayed discovery and Retry without a model request", { timeout: 30_000 }, async () => {
  const scope = await mkdtemp(join(tmpdir(), "flow-claude-mcp-"));
  const mcp = new McpSession([{ id: "fixture", name: "Fixture", enabledByDefault: true,
    transport: "stdio", command: process.execPath, args: ["--experimental-strip-types", resolve("test/fixtures/mcp-server.ts")] }], scope);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const servers = claudeMcpServers(mcp);
  let initialListingComplete = false;
  servers.fixture!.instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    initialListingComplete = true;
    return { tools: [] };
  });
  const stream = query({ prompt: (async function* () { await waiting; })(), options: {
    cwd: scope, settingSources: [], mcpServers: servers, tools: [],
    env: { ...process.env, HOME: scope, CLAUDE_CONFIG_DIR: scope,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "dummy-local-key",
      ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined },
  } });
  try {
    const tools = async () => (await stream.mcpServerStatus()).find((server) => server.name === "fixture")?.tools?.map((tool) => tool.name).sort() ?? [];
    await refreshClaudeMcp({
      mcpServerStatus: () => stream.mcpServerStatus(),
      setMcpServers: (servers) => {
        assert.equal(initialListingComplete, true, "startup tool listing must finish before removal");
        return stream.setMcpServers(servers);
      },
    }, mcp);
    assert.deepEqual(await tools(), []);
    await mcp.open();
    assert.equal(mcp.tools().length, 2);
    await refreshClaudeMcp(stream, mcp);
    assert.deepEqual(await tools(), ["echo", "fail"]);
    await mcp.retry("fixture");
    await refreshClaudeMcp(stream, mcp);
    assert.deepEqual(await tools(), ["echo", "fail"]);
  } finally {
    finish();
    stream.close();
    await mcp.dispose();
    await rm(scope, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
