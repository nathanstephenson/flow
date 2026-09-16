import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpSession } from "../src/backend/mcp.ts";
import { claudeMcpServers } from "../src/backend/claude/mcp.ts";
import { piMcpTools } from "../src/backend/pi/mcp.ts";
import { McpAuth } from "../src/daemon/mcp-auth.ts";
import { ConfigStore } from "../src/daemon/config-store.ts";

const connection = {
  id: "fixture",
  name: "Fixture",
  enabledByDefault: true,
  transport: "stdio" as const,
  command: process.execPath,
  args: ["--experimental-strip-types", resolve("test/fixtures/mcp-server.ts")],
};
test(
  "stdio MCP tools execute through both Flow adapter bridges and retry",
  { timeout: 30_000 },
  async () => {
    const mcp = new McpSession([connection], process.cwd());
    try {
      await mcp.open();
      assert.deepEqual(mcp.status(), [
        { id: "fixture", state: "connected", tools: 2 },
      ]);
      const pi = piMcpTools(mcp);
      assert.deepEqual(
        (
          await pi
            .find((tool) => tool.label === "echo")!
            .execute("call", { text: "hello" })
        ).content,
        [{ type: "text", text: "hello" }],
      );
      await assert.rejects(
        pi.find((tool) => tool.label === "fail")!.execute("fail", {}),
        /Fixture failure/,
      );
      const gateway = claudeMcpServers(mcp).fixture!;
      const [serverTransport, clientTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1" });
      try {
        await gateway.instance.connect(serverTransport);
        await client.connect(clientTransport);
        const listed = await client.listTools();
        const echo = listed.tools.find(
          (tool) => tool.name === pi[0]!.name.split("__").at(-1),
        );
        assert.ok(echo);
        const result = await client.callTool({
          name: echo.name,
          arguments: { text: "bridge" },
        });
        assert.deepEqual(result.content, [{ type: "text", text: "bridge" }]);
        await mcp.retry(connection.id);
        assert.equal(mcp.status()[0]?.state, "connected");
      } finally {
        await client.close();
        await gateway.instance.close();
      }
    } finally {
      await mcp.dispose();
    }
  },
);

test(
  "failed MCP connections do not prevent other tools opening",
  { timeout: 30_000 },
  async () => {
    const mcp = new McpSession(
      [
        { ...connection, id: "missing", command: "/missing-flow-mcp-command" },
        connection,
      ],
      process.cwd(),
    );
    try {
      await mcp.open();
      assert.equal(
        mcp.status().find((state) => state.id === "missing")?.state,
        "failed",
      );
      assert.equal(mcp.tools().length, 2);
    } finally {
      await mcp.dispose();
    }
  },
);

test("OAuth credentials are private, shared per connection, and separate from Settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-"));
  try {
    const config = new ConfigStore(root);
    const connection = {
      id: "remote",
      name: "Remote",
      transport: "http" as const,
      url: "https://example.test/mcp",
      oauth: true,
      headers: {},
      enabledByDefault: true,
    };
    config.update({ mcp: [connection] });
    const auth = new McpAuth(root);
    await auth
      .provider(connection)
      .saveTokens({ access_token: "secret", token_type: "Bearer" });
    assert.equal(
      (await new McpAuth(root).provider(connection).tokens())?.access_token,
      "secret",
    );
    assert.equal(
      await auth
        .provider({ ...connection, url: "https://different.test/mcp" })
        .tokens(),
      undefined,
    );
    assert.equal(JSON.stringify(config.view()).includes("secret"), false);
    assert.equal(
      readFileSync(join(root, "config.json"), "utf8").includes("secret"),
      false,
    );
    assert.equal(
      statSync(join(root, "mcp-credentials.json")).mode & 0o777,
      0o600,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
