import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { prepareClaudeState } from "../../src/backend/worker/claude-state.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { isolationIntegration } from "../isolation-fixture.ts";
import { until } from "./pi-fixture.ts";
import { claudeAuthFixture } from "./claude-auth-fixture.ts";

const cli = join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
const actualCli = { skip: process.platform !== "linux" || !existsSync(cli) ? "requires installed Linux Claude CLI" : false, timeout: 60_000 };

test("installed Claude: two unrestricted SDK workers and normal CLI share atomic OAuth storage and locks", actualCli, async t => {
  const f = await claudeAuthFixture(t);
  const states = [f.state("worker-a"), f.state("worker-b")];
  const events: BackendEvent[][] = [[], []];
  // Starting both workers before either refresh finishes exercises stale-token re-read under
  // the actual CLI's cross-process lock. They must not refresh the same rotating token twice.
  const starting = Promise.all(states.map((stateDir, i) => new WorkerBackend({ backend: "claude",
    env: { ...f.env, FLOW_CLAUDE_PATH: cli }, isolationEnabled: () => false })
    .create({ scope: f.scope, stateDir, emit: event => events[i]!.push(event) }).then(session => {
      t.after(() => session.dispose());
      return session;
    })));
  const normal = spawn(cli, ["--print", "--output-format", "stream-json", "--verbose", "fixture"],
    { cwd: f.scope, env: { ...process.env, ...f.env }, stdio: ["ignore", "pipe", "pipe"] });
  normal.stdout.resume(); normal.stderr.resume();
  t.after(() => normal.kill("SIGKILL"));
  const sessions = await starting;
  await Promise.all(sessions.map(async (session, i) => {
    await session.prompt("fixture");
    await until(() => events[i]!.some(event => event.type === "turn_ended"), 20_000);
  }));
  await until(() => normal.exitCode !== null, 20_000);
  assert.deepEqual(f.refreshTokens, ["fake-old-refresh"], "one refresh despite concurrent stale-token workers");
  assert.equal(f.lockSeen(), true, "CLI refresh lock lives at the normal auth root");
  assert.equal(f.credentials().accessToken, "fake-new-access");
  assert.equal(f.credentials().refreshToken, "fake-new-refresh");
  assert.ok(f.authorization.length >= 3);
  assert.ok(f.authorization.every(value => value === "Bearer fake-new-access"));
  await Promise.all(sessions.map(session => session.dispose()));
  for (const state of states) assert.deepEqual(readdirSync(state), ["claude-projects"], "no durable credentials");
  // A fresh Backend Session after disposal must read the rotated token from the ordinary store.
  const rebuiltEvents: BackendEvent[] = [];
  const rebuilt = await new WorkerBackend({ backend: "claude", env: { ...f.env, FLOW_CLAUDE_PATH: cli },
    isolationEnabled: () => false }).create({ scope: f.scope, stateDir: states[0]!, emit: event => rebuiltEvents.push(event) });
  try {
    await rebuilt.prompt("rebuilt");
    await until(() => rebuiltEvents.some(event => event.type === "turn_ended"), 20_000);
    assert.deepEqual(f.refreshTokens, ["fake-old-refresh"], "rebuild does not recover a discarded stale copy");
  } finally { await rebuilt.dispose(); }
});

test("installed Claude: restricted OAuth rotation never updates the global store or service namespace", {
  ...actualCli, skip: actualCli.skip || isolationIntegration.skip,
}, async t => {
  const f = await claudeAuthFixture(t), before = f.credentials(), beforeFiles = readdirSync(f.auth), events: BackendEvent[] = [];
  const session = await new WorkerBackend({ backend: "claude", env: { ...f.env,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: f.auth }, readablePaths: [f.cert], isolationEnabled: () => true })
    .create({ scope: f.scope, stateDir: f.state("restricted"), emit: event => events.push(event) });
  try {
    await session.prompt("fixture");
    await until(() => events.some(event => event.type === "turn_ended"), 20_000);
    assert.deepEqual(f.refreshTokens, ["fake-old-refresh"]);
    assert.ok(f.authorization.includes("Bearer fake-new-access"));
    assert.equal(f.lockSeen(), false, "no global refresh lock write");
  } finally { await session.dispose(); }
  assert.deepEqual(f.credentials(), before, "restricted credentials are never written back, even on disposal");
  assert.deepEqual(readdirSync(f.auth), beforeFiles, "restricted refresh creates no global auth state or locks");
});

test("unrestricted auth override preserves default and custom macOS keychain identity strings", t => {
  const root = mkdtempSync(join(tmpdir(), "flow-auth-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), auth = join(home, ".claude");
  mkdirSync(auth, { recursive: true });
  for (const [i, inherited, expected] of [
    [0, { HOME: home }, ""],
    [1, { HOME: home, CLAUDE_CONFIG_DIR: auth }, auth],
    [2, { HOME: home, CLAUDE_CONFIG_DIR: auth, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, ""],
    [3, { HOME: home, CLAUDE_CONFIG_DIR: auth, CLAUDE_SECURESTORAGE_CONFIG_DIR: "custom-spelling" }, "custom-spelling"],
  ] as const) {
    const state = join(root, `identity-${i}`);
    mkdirSync(state);
    const view = prepareClaudeState(state, inherited);
    try {
      assert.equal(view.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, expected);
      assert.equal(existsSync(join(view.env.CLAUDE_CONFIG_DIR!, ".credentials.json")), false);
    } finally { view.cleanup(); }
  }
});
