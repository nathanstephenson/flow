import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detectFilesystemIsolationSupport } from "../src/isolation/support.ts";

// Check the probe's own mount destination, never a global /tmp inventory: other Session Host
// startup tests can be detecting support at the same time.
function assertOwnScopeRemoved(record: string) {
  const args = readFileSync(record, "utf8").trim().split("\n");
  const scope = args.find(arg => /^\/tmp\/flow-isolation-support-[A-Za-z0-9]{6}$/.test(arg));
  assert.ok(scope, "recorded descriptor mount and working directory identify this probe's Scope");
  assert.equal(existsSync(scope), false, "the probe's temporary Scope was removed");
  return args;
}
const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

describe("filesystem isolation capability detection", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join("/tmp", "flow-support-test-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("returns an immediate readable non-Linux result without trying a launcher", async () => {
    assert.deepEqual(await detectFilesystemIsolationSupport({ stateRoot: root, platform: "darwin",
      env: { FLOW_BWRAP_PATH: "/does/not/exist" } }), {
      supported: false, reason: "Filesystem isolation requires Linux and Bubblewrap",
    });
  });

  it("reports missing Bubblewrap instead of claiming enforcement", { skip: process.platform !== "linux" }, async () => {
    const result = await detectFilesystemIsolationSupport({ stateRoot: root,
      env: { FLOW_BWRAP_PATH: join(root, "missing-bwrap") } });
    assert.equal(result.supported, false);
    assert.match(result.reason ?? "", /Executable not found.*missing-bwrap/);
    assert.doesNotMatch(result.reason ?? "", /unrestricted launch refused/, "support reason must not contradict the authorized automatic fallback");
  });

  it("actually launches the complete descriptor mount probe and cleans up after failure", { skip: process.platform !== "linux" }, async () => {
    const launcher = join(root, "bwrap"), record = join(root, "probe-args");
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(record)}\necho 'namespace permission denied' >&2\nexit 1\n`, { mode: 0o700 });
    const result = await detectFilesystemIsolationSupport({ stateRoot: root, env: { FLOW_BWRAP_PATH: launcher, PATH: "/usr/bin:/bin" } });
    assert.equal(result.supported, false);
    assert.match(result.reason ?? "", /namespace\/mount probe failed.*namespace permission denied/);
    const args = assertOwnScopeRemoved(record);
    assert.ok(args.includes("--unshare-user"));
    assert.ok(args.includes("--unshare-pid"));
    assert.ok(args.includes("--bind-fd"));
    assert.ok(args.includes("--tmpfs") && args.includes("/tmp"), "the actual state root beneath /tmp is masked by its ancestor");
    assert.deepEqual(args.slice(-2), ["--", "/bin/true"]);
  });

  it("cleans up after probing the installed real enforcement mechanism", { skip: process.platform !== "linux" }, async () => {
    const launcher = join(root, "bwrap"), record = join(root, "probe-args");
    const actual = process.env.FLOW_BWRAP_PATH ?? "/usr/bin/bwrap";
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(record)}\nexec ${quote(actual)} "$@"\n`, { mode: 0o700 });
    const result = await detectFilesystemIsolationSupport({ stateRoot: root, env: { FLOW_BWRAP_PATH: launcher, PATH: "/usr/bin:/bin" } });
    if (result.supported) assert.equal(result.reason, undefined);
    else assert.ok(result.reason, "unavailable actual enforcement has a readable reason");
    assertOwnScopeRemoved(record);
  });
});
