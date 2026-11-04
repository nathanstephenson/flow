import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { ConfigStore } from "../src/daemon/config-store.ts";
import { detectSandboxSupport, fillTemplate, parseSandboxProvider, sandboxProviderPath } from "../src/isolation/sandbox.ts";

const valid = {
  version: 1,
  nodePath: "/usr/local/bin/node",
  claudePath: "/home/agent/.local/bin/claude",
  probe: ["provider", "probe"],
  create: ["provider", "create", "--spec", "{spec}"],
  exec: ["provider", "exec", "{name}", "--cwd", "{cwd}", "--"],
  remove: ["provider", "rm", "{name}"],
};

describe("sandbox provider file", () => {
  it("accepts a valid file, including the raw sbx commands", () => {
    assert.deepEqual(parseSandboxProvider(JSON.stringify(valid)), valid);
    const sbx = { ...valid, claudeAuthDir: "/state/claude", probe: ["sbx", "ls", "--json"],
      create: ["sbx", "env", "create", "/plan", "{spec}", "--name", "{name}", "--force"],
      exec: ["sbx", "exec", "-i", "-w", "{cwd}", "{name}"], remove: ["sbx", "rm", "--force", "{name}"] };
    assert.deepEqual(parseSandboxProvider(JSON.stringify(sbx)), sbx);
  });

  for (const [label, change, error] of [
    ["wrong version", { version: 2 }, /version must be 1/],
    ["relative node path", { nodePath: "node" }, /nodePath must be an absolute path/],
    ["missing claude path", { claudePath: undefined }, /claudePath must be an absolute path/],
    ["relative auth dir", { claudeAuthDir: "claude" }, /claudeAuthDir must be an absolute path/],
    ["missing command", { remove: undefined }, /remove must be a non-empty array/],
    ["empty command", { probe: [] }, /probe must be a non-empty array/],
    ["non-string part", { probe: ["provider", 1] }, /probe must be a non-empty array/],
    ["missing spec", { create: ["provider", "create"] }, /create must contain \{spec\}/],
    ["missing cwd", { exec: ["provider", "exec", "{name}", "--"] }, /exec must contain \{cwd\}/],
    ["unknown placeholder", { remove: ["provider", "rm", "{name}", "{spec}"] }, /remove has unknown placeholder \{spec\}/],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseSandboxProvider(JSON.stringify({ ...valid, ...change })), error);
    });
  }

  it("fills whole-element placeholders only", () => {
    assert.deepEqual(fillTemplate(valid.exec, { name: "flow-1", cwd: "/a b" }), ["provider", "exec", "flow-1", "--cwd", "/a b", "--"]);
    assert.deepEqual(fillTemplate(["x{name}"], { name: "flow-1" }), ["x{name}"]);
  });

  it("uses FLOW_SANDBOX_PROVIDER before the state root file", () => {
    assert.equal(sandboxProviderPath("/state", {}), "/state/sandbox-provider.json");
    assert.equal(sandboxProviderPath("/state", { FLOW_SANDBOX_PROVIDER: "/etc/flow/provider.json" }), "/etc/flow/provider.json");
  });
});

describe("sandbox provider probe", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "flow-sandbox-provider-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function provider(probeScript: string) {
    const script = join(root, "probe.sh");
    writeFileSync(script, `#!/bin/sh\n${probeScript}\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(root, "sandbox-provider.json"), JSON.stringify({ ...valid, probe: [script] }));
  }

  it("reports a missing file", async () => {
    assert.deepEqual(await detectSandboxSupport({ stateRoot: root, env: {} }),
      { supported: false, reason: `No sandbox provider file at ${join(root, "sandbox-provider.json")}.` });
  });

  it("reports an invalid file", async () => {
    writeFileSync(join(root, "sandbox-provider.json"), "{");
    const support = await detectSandboxSupport({ stateRoot: root, env: {} });
    assert.equal(support.supported, false);
    assert.match(!support.supported ? support.reason : "", /Invalid sandbox provider file/);
  });

  it("returns the provider when the probe exits 0", async () => {
    provider("echo anything");
    const support = await detectSandboxSupport({ stateRoot: root, env: {} });
    assert.ok(support.supported);
    assert.equal(support.provider.nodePath, "/usr/local/bin/node");
    assert.equal(support.provider.remove[1], "rm");
  });

  for (const [label, script, reason] of [
    ["the probe's error output", `echo "not signed in" >&2; exit 1`, /not signed in/],
    ["a failing exit and no output", `exit 3`, /Command failed/],
  ] as const) {
    it(`fails with ${label}`, async () => {
      provider(script);
      const support = await detectSandboxSupport({ stateRoot: root, env: {} });
      assert.equal(support.supported, false);
      assert.match(!support.supported ? support.reason : "", reason);
    });
  }

  it("fails when the probe passes its time limit", async () => {
    provider("sleep 5");
    const support = await detectSandboxSupport({ stateRoot: root, env: {}, timeoutMs: 200 });
    assert.equal(support.supported, false);
  });

  it("shows provider support in the isolation status", async () => {
    provider("true");
    const store = new ConfigStore(root, async () => ({ supported: false, reason: "no bwrap" }));
    await store.initializeFilesystemIsolation();
    assert.deepEqual(store.filesystemIsolationStatus().sandbox, { supported: true, path: join(root, "sandbox-provider.json") });
    assert.equal(store.sandboxSupport()?.supported, true);
  });
});
