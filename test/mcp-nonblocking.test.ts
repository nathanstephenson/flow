import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionHost } from "../src/daemon/host.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";

test(
  "an unresponsive MCP process cannot hold Agent Session creation or shutdown",
  { timeout: 5000 },
  async () => {
    const host = new SessionHost({
      mcpConnections: () => [
        {
          id: "slow",
          name: "Slow",
          enabledByDefault: true,
          transport: "stdio",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
      ],
    });
    host.registerBackend(new FakeBackend());
    try {
      const started = Date.now();
      const id = await host.create({ scope: process.cwd() });
      assert.ok(Date.now() - started < 1000);
      assert.equal(host.list()[0]?.status, "idle");
      assert.equal(host.mcpStatus(id)[0]?.state, "connecting");
    } finally {
      await host.shutdown();
    }
  },
);
