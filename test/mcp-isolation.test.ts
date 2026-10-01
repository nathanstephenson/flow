import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpSession } from "../src/backend/mcp.ts";
import { prepareFilesystemIsolation } from "../src/isolation/filesystem.ts";

const fixture = {
  id: "adversary", name: "Adversary", enabledByDefault: true, transport: "stdio" as const,
  command: process.execPath, args: ["--experimental-strip-types", resolve("test/fixtures/mcp-isolation-server.ts")],
};
const pause = (ms = 20) => new Promise((done) => setTimeout(done, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const recordArguments = (log: string) => `printf '%s\\n' "$@" > ${quote(log)}
previous=
for value in "$@"; do
  if [ "$value" = /tmp/flow-isolation/state ]; then readlink "/proc/$$/fd/$previous" >> ${quote(log)}; fi
  previous=$value
done
`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "Timed out"); await pause(); }
}
async function available(t: TestContext): Promise<boolean> {
  try {
    (await prepareFilesystemIsolation({ scope: process.cwd(), command: process.execPath, args: [], credentials: "none" })).cleanup();
    return true;
  } catch (error) { t.skip(`Filesystem isolation unavailable: ${(error as Error).message}`); return false; }
}

test("stdio MCP and descendants cannot write/delete outside Scope, via symlinks, or in host state", { timeout: 30_000 }, async (t) => {
  if (!await available(t)) return;
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-boundary-"));
  const scope = join(root, "scope"), assets = join(root, "assets"), state = join(root, "host-state");
  for (const path of [scope, assets, state]) mkdirSync(path);
  // A real script/package under /tmp needs its read-only runtime assets restored after
  // scratch masking. Its sentinel is visible, so denial tests the read-only bind too.
  writeFileSync(join(assets, "package.json"), '{"type":"module"}');
  writeFileSync(join(assets, "server.ts"), readFileSync(resolve("test/fixtures/mcp-isolation-server.ts")));
  symlinkSync(resolve("node_modules"), join(assets, "node_modules"), "dir");
  const sentinel = join(assets, "sentinel"), secret = join(state, "token");
  writeFileSync(sentinel, "outside intact"); writeFileSync(secret, "host intact");
  symlinkSync(assets, join(scope, "outside-link"), "dir");
  symlinkSync(state, join(scope, "state-link"), "dir");
  const mcp = new McpSession([{ ...fixture, args: ["--experimental-strip-types", join(assets, "server.ts")] }], scope, undefined, false, undefined, [state]);
  try {
    await mcp.open();
    assert.equal(mcp.status()[0]?.state, "connected");
    const result = await mcp.tools().find((tool) => tool.definition.name === "attack")!.call({
      targets: [sentinel, join(scope, "outside-link", "sentinel"), secret, join(scope, "state-link", "token")],
    });
    const text = result.content[0]; assert.equal(text?.type, "text");
    const attempts = JSON.parse((text as { text: string }).text);
    assert.equal(attempts.results.includes("allowed"), false);
    assert.equal(attempts.descendant.includes("allowed"), false);
    assert.ok(attempts.results.includes("EROFS"), "visible execution assets must be read-only");
    assert.equal(readFileSync(sentinel, "utf8"), "outside intact");
    assert.equal(readFileSync(secret, "utf8"), "host intact");
    assert.equal(readFileSync(join(scope, "scope-write"), "utf8"), "allowed");
    await mcp.retry(fixture.id);
    assert.equal(mcp.status()[0]?.state, "connected");
    await mcp.tools().find((tool) => tool.definition.name === "linger")!.call({});
    await until(() => existsSync(join(scope, "heartbeat")));
    await mcp.dispose();
    const heartbeat = readFileSync(join(scope, "heartbeat"), "utf8");
    await pause(150);
    assert.equal(readFileSync(join(scope, "heartbeat"), "utf8"), heartbeat, "detached descendants must die with the transport");
    assert.deepEqual(mcp.tools(), []);
  } finally { await mcp.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("stdio Retry and disposal retain private mount state until an uncooperative transport exits", { timeout: 30_000 }, async (t) => {
  if (!await available(t)) return;
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-teardown-"));
  const scope = join(root, "scope"), log = join(root, "args"); mkdirSync(scope);
  const saved = process.env.FLOW_BWRAP_PATH, wrapper = join(root, "bwrap");
  writeFileSync(wrapper, `#!/bin/sh\n${recordArguments(log)}exec ${quote(saved ?? "bwrap")} "$@"\n`, { mode: 0o700 });
  process.env.FLOW_BWRAP_PATH = wrapper;
  const mcp = new McpSession([{ ...fixture, args: [...fixture.args, "--stubborn"] }], scope);
  const backend = () => readFileSync(log, "utf8").split("\n").find((value) => /\/flow-isolation-[^/]+\/backend$/.test(value))!;
  try {
    await mcp.open();
    assert.equal(mcp.status()[0]?.state, "connected");
    const old = backend(); assert.ok(existsSync(old));
    const retrying = mcp.retry(fixture.id);
    await pause(200);
    assert.ok(existsSync(old), "mount state must survive stdin closure and pending SIGTERM/SIGKILL");
    await retrying;
    assert.equal(existsSync(old), false);
    assert.equal(mcp.status()[0]?.state, "connected");
    const current = backend(); assert.notEqual(current, old);
    const disposing = mcp.dispose();
    await pause(200); assert.ok(existsSync(current));
    await disposing;
    assert.equal(existsSync(current), false);
  } finally {
    await mcp.dispose();
    if (saved === undefined) delete process.env.FLOW_BWRAP_PATH; else process.env.FLOW_BWRAP_PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["spawn", "connect"] as const) test(`stdio ${mode} failure cleans restricted mount state after transport exit`, { timeout: 15_000 }, async (t) => {
  if (!await available(t)) return;
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-launch-failure-"));
  const scope = join(root, "scope"), log = join(root, "args"); mkdirSync(scope);
  const saved = process.env.FLOW_BWRAP_PATH, wrapper = join(root, "bwrap");
  // Execute the real namespace/mount probe, then remove the executable to provoke a
  // genuine transport spawn failure. No fake launcher ever runs the MCP command.
  const launch = mode === "spawn" ? `${quote(saved ?? "bwrap")} "$@"\nstatus=$?\nrm -- "$0"\nexit "$status"`
    : `exec ${quote(saved ?? "bwrap")} "$@"`;
  writeFileSync(wrapper, `#!/bin/sh\n${recordArguments(log)}${launch}\n`, { mode: 0o700 });
  process.env.FLOW_BWRAP_PATH = wrapper;
  const mcp = new McpSession([{ ...fixture, args: ["-e", "process.exit(1)"] }], scope);
  try {
    await mcp.open();
    assert.deepEqual(mcp.status(), [{ id: fixture.id, state: "failed", tools: 0 }]);
    assert.deepEqual(mcp.tools(), []);
    const backend = readFileSync(log, "utf8").split("\n").find((value) => /\/flow-isolation-[^/]+\/backend$/.test(value));
    assert.ok(backend); assert.equal(existsSync(backend), false);
  } finally {
    await mcp.dispose();
    if (saved === undefined) delete process.env.FLOW_BWRAP_PATH; else process.env.FLOW_BWRAP_PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing enforcement and unsafe execution assets refuse stdio without rejecting open or launching", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-refusal-"));
  const scope = join(root, "scope"), state = join(root, "host-state");
  mkdirSync(scope); mkdirSync(state);
  const marker = join(scope, "launched");
  const saved = process.env.FLOW_BWRAP_PATH;
  try {
    process.env.FLOW_BWRAP_PATH = "/missing-flow-bwrap";
    const unavailable = new McpSession([{ ...fixture, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`] }], scope);
    try {
      await unavailable.open();
      assert.deepEqual(unavailable.status(), [{ id: fixture.id, state: "failed", tools: 0 }]);
      assert.deepEqual(unavailable.tools(), []);
      assert.equal(existsSync(marker), false);
      await unavailable.retry(fixture.id);
      assert.equal(unavailable.status()[0]?.state, "failed");
    } finally { await unavailable.dispose(); }
    if (saved === undefined) delete process.env.FLOW_BWRAP_PATH; else process.env.FLOW_BWRAP_PATH = saved;
    const script = join(state, "server.js");
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`);
    // Policy rejects a protected directory instead of whitelisting it as a script asset.
    const unsafe = new McpSession([{ ...fixture, args: [script] }], scope, undefined, true, undefined, [state]);
    try {
      await unsafe.open();
      assert.equal(unsafe.status()[0]?.state, "failed");
      assert.deepEqual(unsafe.tools(), []);
      assert.equal(existsSync(marker), false);
    } finally { await unsafe.dispose(); }
  } finally {
    if (saved === undefined) delete process.env.FLOW_BWRAP_PATH; else process.env.FLOW_BWRAP_PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("disposal during asynchronous stdio preparation never starts the server and cleans its mount state", { timeout: 15_000 }, async (t) => {
  if (!await available(t)) return;
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-preparing-"));
  const scope = join(root, "scope"); mkdirSync(scope);
  const entered = join(root, "entered"), release = join(root, "release"), log = join(root, "args");
  const saved = process.env.FLOW_BWRAP_PATH;
  const real = saved ?? "bwrap";
  const wrapper = join(root, "bwrap");
  writeFileSync(wrapper, `#!/bin/sh\n${recordArguments(log)}touch ${quote(entered)}\nwhile [ ! -f ${quote(release)} ]; do sleep 0.02; done\nexec ${quote(real)} "$@"\n`, { mode: 0o700 });
  process.env.FLOW_BWRAP_PATH = wrapper;
  const marker = join(scope, "launched");
  const mcp = new McpSession([{ ...fixture, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`] }], scope);
  try {
    const opening = mcp.open();
    await until(() => existsSync(entered));
    const argv = readFileSync(log, "utf8").split("\n");
    const backend = argv.find((value) => /\/flow-isolation-[^/]+\/backend$/.test(value));
    assert.ok(backend && existsSync(backend));
    const disposing = mcp.dispose();
    writeFileSync(release, "go");
    await Promise.all([opening, disposing]);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(backend), false);
    assert.deepEqual(mcp.tools(), []);
  } finally {
    writeFileSync(release, "go");
    await mcp.dispose();
    if (saved === undefined) delete process.env.FLOW_BWRAP_PATH; else process.env.FLOW_BWRAP_PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
