import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, defaultConfig } from "../src/daemon/config.ts";

test("MCP connections default on and settings reject credentials", () => {
  const mcp = [
    { id: "files", name: "Files", transport: "stdio", command: "node" },
  ];
  assert.equal(
    applyPatch(defaultConfig(), { mcp }).mcp?.[0]?.enabledByDefault,
    true,
  );
  assert.throws(() =>
    applyPatch(defaultConfig(), { mcp: [{ ...mcp[0], tokens: {} }] }),
  );
  assert.throws(() => applyPatch(defaultConfig(), { mcp: [mcp[0], mcp[0]] }));
});
