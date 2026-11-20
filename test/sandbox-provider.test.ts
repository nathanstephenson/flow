import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { ConfigStore } from "../src/daemon/config-store.ts";
import { createSandbox, detectSandboxSupport, fillTemplate, hostClaude, parseSandboxProvider, sandboxMounts, sandboxProviderPath } from "../src/isolation/sandbox.ts";
import { fakeHostClaude, fakeProvider } from "./backend/sandbox-fixture.ts";

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
    const shell = { ...valid, shell: ["sbx", "exec", "-it", "-w", "{cwd}", "{name}"] };
    assert.deepEqual(parseSandboxProvider(JSON.stringify(shell)), shell);
    const host = { ...valid, claudePath: undefined, hostClaudePath: "/home/me/.local/bin/claude" };
    assert.deepEqual(parseSandboxProvider(JSON.stringify(host)), JSON.parse(JSON.stringify(host)));
  });

  for (const [label, change, error] of [
    ["wrong version", { version: 2 }, /version must be 1/],
    ["relative node path", { nodePath: "node" }, /nodePath must be an absolute path/],
    ["missing claude path", { claudePath: undefined }, /exactly one of claudePath and hostClaudePath is required/],
    ["guest and host claude paths", { hostClaudePath: "/home/me/.local/bin/claude" }, /exactly one of claudePath and hostClaudePath is required/],
    ["relative host claude path", { claudePath: undefined, hostClaudePath: "claude" }, /hostClaudePath must be an absolute path/],
    ["relative auth dir", { claudeAuthDir: "claude" }, /claudeAuthDir must be an absolute path/],
    ["missing command", { remove: undefined }, /remove must be a non-empty array/],
    ["empty command", { probe: [] }, /probe must be a non-empty array/],
    ["non-string part", { probe: ["provider", 1] }, /probe must be a non-empty array/],
    ["missing spec", { create: ["provider", "create"] }, /create must contain \{spec\}/],
    ["missing cwd", { exec: ["provider", "exec", "{name}", "--"] }, /exec must contain \{cwd\}/],
    ["unknown placeholder", { remove: ["provider", "rm", "{name}", "{spec}"] }, /remove has unknown placeholder \{spec\}/],
    ["empty shell", { shell: [] }, /shell must be a non-empty array/],
    ["shell without cwd", { shell: ["sbx", "exec", "-it", "{name}"] }, /shell must contain \{cwd\}/],
    ["shell with unknown placeholder", { shell: ["sbx", "exec", "-it", "-w", "{cwd}", "{name}", "{spec}"] }, /shell has unknown placeholder \{spec\}/],
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

describe("sandbox Shell command", () => {
  it("fills the shell template and starts a login bash, or is undefined without one", async (t) => {
    const f = fakeProvider(t);
    const spec = { name: "flow-test", workspace: f.scope, mounts: sandboxMounts([f.scope, f.state], []), env: {} };
    const plain = await createSandbox(f.support.provider, spec, join(f.state, "sandbox.json"));
    assert.equal(plain.shellCommand(f.scope), undefined);
    await plain.close();
    const sandbox = await createSandbox({ ...f.support.provider, shell: ["sbx", "exec", "-it", "-w", "{cwd}", "{name}"] }, spec, join(f.state, "sandbox.json"));
    assert.deepEqual(sandbox.shellCommand(f.scope), { command: "sbx", args: ["exec", "-it", "-w", f.scope, "flow-test", "/bin/bash", "-l"] });
    await sandbox.close();
  });
});

describe("host-installed Claude", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "flow-host-claude-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("resolves the link to the versioned executable and its versions directory", () => {
    const install = fakeHostClaude(root, "2.1.0");
    assert.deepEqual(hostClaude(install.link), { executable: install.executable, directory: install.versions });
  });

  it("follows a link repointed by an update", () => {
    fakeHostClaude(root, "2.1.0");
    const install = fakeHostClaude(root, "2.2.0");
    assert.equal(hostClaude(install.link).executable, install.executable);
  });

  it("refuses an executable for another CPU", () => {
    const install = fakeHostClaude(root, "2.1.0", 3);
    assert.throws(() => hostClaude(install.link), /is not a 64-bit .* executable/);
  });

  it("refuses a non-ELF executable, such as a macOS binary or a script", () => {
    const { link, executable } = fakeHostClaude(root, "2.1.0");
    writeFileSync(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    assert.throws(() => hostClaude(link), /is not a Linux native executable/);
    writeFileSync(executable, "#!/usr/bin/env node\n");
    assert.throws(() => hostClaude(link), /is not a Linux native executable/);
  });

  it("refuses a missing executable", () => {
    assert.throws(() => hostClaude(join(root, "claude")), /ENOENT/);
  });

  it("refuses a directory that is not dedicated to Claude versions", () => {
    const install = fakeHostClaude(root, "2.1.0");
    mkdirSync(join(install.versions, "nested"));
    assert.throws(() => hostClaude(install.link), /holds nested, which is not a regular file/);
    rmSync(join(install.versions, "nested"), { recursive: true });
    symlinkSync("/etc/passwd", join(install.versions, "linked"));
    assert.throws(() => hostClaude(install.link), /holds linked, which is not a regular file/);
  });
});
