import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import { resolveClaudeExecutable } from "../src/backend/claude/index.ts";
import { registerBackends } from "../src/backend/registry.ts";
import { SessionHost } from "../src/daemon/host.ts";

describe("packaging", () => {
  afterEach(() => {
    delete process.env["GOODHARNESS_CLAUDE_PATH"];
  });

  it("leaves CLI resolution to the SDK when running from source", () => {
    assert.equal(resolveClaudeExecutable(), undefined);
  });

  it("honours an explicit Claude Code path", () => {
    process.env["GOODHARNESS_CLAUDE_PATH"] = "/somewhere/claude";
    assert.equal(resolveClaudeExecutable(), "/somewhere/claude");
  });

  it("registers every backend without loading pi", () => {
    const host = new SessionHost();
    registerBackends(host);
    assert.deepEqual(host.backendNames().sort(), ["claude", "fake", "pi"]);
  });

  it("reports a missing backend module as an actionable error", async () => {
    const host = new SessionHost();
    registerBackends(host);
    await assert.rejects(
      () => host.create({ scope: "/tmp", backend: "nope" }),
      /Unknown backend: nope/,
    );
  });
});
