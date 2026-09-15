import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { BackendCreateOptions } from "../src/backend/types.ts";
import type { McpConnection } from "../src/protocol/mcp.ts";

test(
  "Agent Session selection survives restart; edits and deletions take effect at Backend Session open",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-mcp-host-"));
    const store = new TranscriptStore(root);
    let connections: McpConnection[] = [
      {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "/missing-mcp",
        args: [],
        enabledByDefault: true,
      },
      {
        id: "b",
        name: "B",
        transport: "stdio",
        command: "/missing-mcp",
        args: [],
        enabledByDefault: false,
      },
    ];
    const opened: BackendCreateOptions[] = [];
    const build = () => {
      const host = new SessionHost({
        store,
        mcpConnections: () => connections,
      });
      const fake = new FakeBackend();
      host.registerBackend({
        name: "fake",
        create: async (options) => {
          opened.push(options);
          return fake.create(options);
        },
      });
      return host;
    };
    let host = build();
    try {
      const id = await host.create({ scope: root });
      assert.deepEqual(
        opened.at(-1)?.mcp?.connections.map((connection) => connection.id),
        ["a"],
      );
      assert.equal(host.list()[0]?.status, "idle");
      const explicit = await host.create({
        scope: root,
        mcpConnectionIds: ["b"],
      });
      assert.deepEqual(
        opened.at(-1)?.mcp?.connections.map((connection) => connection.id),
        ["b"],
      );
      connections = connections.map((connection) => ({
        ...connection,
        name: "Edited",
        enabledByDefault: !connection.enabledByDefault,
      }));
      assert.equal(opened.at(-1)?.mcp?.connections[0]?.name, "B");
      await host.shutdown();
      host = build();
      await host.load();
      await host.revive(id);
      assert.deepEqual(
        opened.at(-1)?.mcp?.connections.map((connection) => connection.id),
        ["a"],
      );
      assert.equal(opened.at(-1)?.mcp?.connections[0]?.name, "Edited");
      connections = connections.filter((connection) => connection.id !== "b");
      await host.revive(explicit);
      assert.deepEqual(opened.at(-1)?.mcp?.connections, []);
      await host.create({ scope: root, mcpConnectionIds: ["b"] });
      assert.deepEqual(opened.at(-1)?.mcp?.connections, []);
      await host.create({ scope: root, mcpConnectionIds: [] });
      assert.deepEqual(opened.at(-1)?.mcp?.connections, []);
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
