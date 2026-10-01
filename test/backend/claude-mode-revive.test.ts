import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { isolationIntegration } from "../isolation-fixture.ts";
import { until } from "./pi-fixture.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "flow-claude-revive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = join(root, "scope"), stateDir = join(root, "backend"), home = join(root, "home"), auth = join(home, ".claude");
  for (const dir of [scope, stateDir, auth]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(auth, ".credentials.json"), '{"fixture":"credential"}');
  writeFileSync(join(auth, "CLAUDE.md"), "fixture resource");
  mkdirSync(join(auth, "projects"));
  writeFileSync(join(auth, "projects", "unrelated.jsonl"), "global transcript must not migrate");
  const executable = join(root, "cli.js");
  // Exercise the actual SDK's subprocess options and --resume handling, not a query() mock.
  // Like Claude CLI, this stub resolves records via CLAUDE_CONFIG_DIR/projects + Scope key + ID.
  writeFileSync(executable, `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const readline = require('node:readline');
const resume = process.argv.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length);
const id = resume || crypto.randomUUID();
const config = process.env.CLAUDE_CONFIG_DIR;
const projects = path.join(config, 'projects');
const directory = path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
const file = path.join(directory, id + '.jsonl');
const prior = resume ? fs.readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.mkdirSync(directory, { recursive: true });
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'control_request') {
    if (request.request.subtype === 'get_context_usage') {
      send({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'unsupported' } });
    } else {
      send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
        response: { models: [{ value: 'sonnet', displayName: 'Sonnet', description: '' }] } } });
    }
    return;
  }
  if (request.type !== 'user') return;
  const text = typeof request.message.content === 'string' ? request.message.content : request.message.content.map(p => p.text || '').join('');
  prior.push(text);
  fs.appendFileSync(file, JSON.stringify(text) + '\\n');
  const owned = fs.statSync(projects);
  const report = { config, projects: { dev: owned.dev, ino: owned.ino }, prior,
    credential: fs.readFileSync(path.join(config, '.credentials.json'), 'utf8'),
    resource: fs.readFileSync(path.join(config, 'CLAUDE.md'), 'utf8'),
    globalVisible: fs.existsSync(path.join(projects, 'unrelated.jsonl')),
    hostCredentialVisible: fs.existsSync(${JSON.stringify(join(auth, ".credentials.json"))}),
    secretStore: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null,
    fullEnv: process.env.FLOW_TEST_UNRESTRICTED_ENV ?? null };
  send({ type: 'system', subtype: 'init', session_id: id, model: 'sonnet' });
  send({ type: 'assistant', session_id: id, parent_tool_use_id: null,
    message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: JSON.stringify(report) }] } });
  send({ type: 'result', subtype: 'success', session_id: id, is_error: false, result: 'ok',
    total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
});
`, { mode: 0o700 });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: auth, FLOW_CLAUDE_PATH: executable,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: auth, FLOW_TEST_UNRESTRICTED_ENV: "preserved" };
  return { root, scope, stateDir, auth, executable, env };
}

async function turn(session: Awaited<ReturnType<WorkerBackend["create"]>>, events: BackendEvent[], text: string) {
  events.length = 0;
  await session.prompt(text);
  await until(() => events.some(event => event.type === "turn_ended"), 10_000);
  const answer = events.find(event => event.type === "message" && event.final);
  assert.ok(answer?.type === "message", JSON.stringify(events));
  return JSON.parse(answer.text);
}

for (const modes of [[false, true, false], [true, false, true]]) {
  test(`Claude durable records survive mode changes ${modes.join(" -> ")}`, { ...isolationIntegration, timeout: 40_000 }, async t => {
    const f = fixture(t);
    let resume: string | undefined;
    const events: BackendEvent[] = [];
    for (const [index, enabled] of modes.entries()) {
      const session = await new WorkerBackend({ backend: "claude", env: f.env,
        readablePaths: [f.executable], isolationEnabled: () => enabled }).create({
        scope: f.scope, stateDir: f.stateDir, ...(resume ? { resume } : {}), emit: event => events.push(event),
        ...(index === 1 ? { autoCompaction: { mode: "disabled" as const } } : {}),
      });
      let config: string;
      try {
        const report = await turn(session, events, `turn-${index}`);
        config = report.config;
        assert.deepEqual(report.prior, Array.from({ length: index + 1 }, (_, i) => `turn-${i}`));
        assert.equal(report.credential, '{"fixture":"credential"}');
        assert.equal(report.resource, "fixture resource");
        assert.equal(report.globalVisible, false, "never import another session's records");
        assert.equal(report.hostCredentialVisible, !enabled, "restricted mode still masks the global store");
        assert.equal(report.fullEnv, enabled ? null : "preserved", "unrestricted Claude retains the ordinary full environment");
        if (enabled) {
          assert.equal(config, "/tmp/flow-isolation/home/.claude", "reuse the restricted staged view");
          assert.equal(report.secretStore, null, "never restore the host credential-service namespace");
        } else assert.notEqual(config, f.auth);
        const owned = statSync(join(f.stateDir, "claude-projects"));
        assert.deepEqual(report.projects, { dev: owned.dev, ino: owned.ino });
        const token = session.resumeToken();
        assert.ok(token);
        if (resume) assert.equal(token, resume);
        resume = token;
      } finally { await session.dispose(); }
      if (!enabled) assert.equal(existsSync(config!), false, "remove ephemeral credential/config view after worker exit");
    }
    assert.deepEqual(readdirSync(f.stateDir), ["claude-projects"], "durable state must not carry global credentials");
    assert.deepEqual(readdirSync(join(f.auth, "projects")), ["unrelated.jsonl"]);
    assert.equal(readFileSync(join(f.auth, ".credentials.json"), "utf8"), '{"fixture":"credential"}');
  });
}

test("direct Claude adapter honors stateDir without changing the process environment", { timeout: 15_000 }, async t => {
  const f = fixture(t), saved = { ...process.env };
  Object.assign(process.env, f.env);
  t.after(() => {
    for (const key of Object.keys(f.env)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const events: BackendEvent[] = [];
  const backend = new ClaudeBackend({ pathToClaudeCodeExecutable: f.executable });
  let resume: string | undefined;
  for (let index = 0; index < 2; index++) {
    const session = await backend.create({ scope: f.scope, stateDir: f.stateDir, ...(resume ? { resume } : {}), emit: event => events.push(event) });
    let config: string;
    try {
      const report = await turn(session, events, `turn-${index}`);
      config = report.config;
      assert.deepEqual(report.prior, Array.from({ length: index + 1 }, (_, i) => `turn-${i}`));
      assert.equal(process.env.CLAUDE_CONFIG_DIR, f.auth);
      resume = session.resumeToken();
      assert.ok(resume);
    } finally { await session.dispose(); }
    assert.equal(existsSync(config!), false);
  }
});

test("enabled Claude mode remains fail closed, even when unrestricted owned records already exist", async t => {
  const f = fixture(t), events: BackendEvent[] = [];
  const session = await new WorkerBackend({ backend: "claude", env: f.env, isolationEnabled: () => false })
    .create({ scope: f.scope, stateDir: f.stateDir, emit: event => events.push(event) });
  let resume: string | undefined;
  try { await turn(session, events, "first"); resume = session.resumeToken(); }
  finally { await session.dispose(); }
  await assert.rejects(new WorkerBackend({ backend: "claude", env: { ...f.env, FLOW_BWRAP_PATH: "/missing-bwrap" },
    isolationEnabled: () => true }).create({ scope: f.scope, stateDir: f.stateDir, ...(resume ? { resume } : {}), emit: () => {} }), /unrestricted launch refused/);
});
