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

test("HTTP headers carry a literal value or a secret reference", () => {
  const http = (headers: unknown) => ({
    id: "remote",
    name: "Remote",
    transport: "http",
    url: "https://example.test/mcp",
    headers,
  });
  const patch = (headers: unknown) => {
    const parsed = applyPatch(defaultConfig(), { mcp: [http(headers)] }).mcp?.[0];
    assert.ok(parsed?.transport === "http");
    return parsed.headers;
  };
  assert.deepEqual(patch(undefined), {});
  assert.deepEqual(patch({
    Authorization: { secret: "linear_token" },
    "X-Tenant-Id": { value: "acme" },
  }), {
    Authorization: { secret: "linear_token" },
    "X-Tenant-Id": { value: "acme" },
  });
  assert.throws(() => patch({ Authorization: { value: "a", secret: "b" } }));
  assert.throws(() => patch({ "Bad Header": { value: "a" } }));
  assert.throws(() => patch({ Authorization: { value: "a\r\nX-Evil: 1" } }));
  assert.throws(() => patch({ Authorization: { secret: "not a name" } }));
});
