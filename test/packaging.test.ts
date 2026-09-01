import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import { resolveClaudeExecutable, seaSpawnTarget } from "../src/backend/claude/index.ts";
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

describe("spawning the CLI from a single executable", () => {
  it("runs a JS install directly instead of through process.execPath", () => {
    // Inside a SEA, process.execPath is the GoodHarness binary, so the SDK's default spawn would
    // re-invoke GoodHarness with the CLI's arguments.
    const target = seaSpawnTarget({
      command: process.execPath,
      args: ["/usr/local/bin/claude", "--output-format", "stream-json"],
    });
    assert.deepEqual(target, {
      command: "/usr/local/bin/claude",
      args: ["--output-format", "stream-json"],
    });
  });

  it("leaves a native install alone", () => {
    // No interpreter here: the binary is the command and args[0] is a flag, so hoisting it would
    // try to execute `--output-format`. The SDK misreports that failure as a libc mismatch.
    const options = {
      command: "/usr/local/share/npm-global/bin/claude",
      args: ["--output-format", "stream-json", "--verbose"],
    };
    assert.deepEqual(seaSpawnTarget(options), options);
  });

  it("leaves a spawn with no script path alone", () => {
    const options = { command: process.execPath, args: [] };
    assert.deepEqual(seaSpawnTarget(options), options);
  });
});
