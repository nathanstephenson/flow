import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-package-')));
const cwd = join(temp, 'unrelated');
const state = join(temp, 'state');
const prefix = join(temp, 'prefix');
mkdirSync(cwd);
mkdirSync(state);
writeFileSync(join(state, 'config.json'), JSON.stringify({ workflowRuntime: { externalSandbox: false, nodePath: process.execPath } }));
const env = { ...process.env, FLOW_STATE_DIR: state };
delete env.FLOW_URL;
for (const key of Object.keys(env)) if (key.startsWith('FLOW_OIDC_')) delete env[key];
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd, env, encoding: 'utf8', timeout: 120_000, ...options,
});
let host;
let hostClosed;
let hostOutput = '';
try {
  if (process.argv.length > 3) throw new Error('usage: test-package.mjs [archive.tgz]');
  if (!process.argv[2]) run('npm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit', timeout: 300_000 });
  const archive = process.argv[2] ? resolve(process.argv[2]) : join(temp, readdirSync(temp).find(name => name.endsWith('.tgz')));
  const files = run('tar', ['-tzf', archive]).trim().split('\n');
  for (const file of files) {
    assert.match(file, /^package\/(?:package\.json|README\.md|LICEN[CS]E(?:\.(?:md|txt))?|dist\/.*\.js|dist\/build-id|web\/dist\/.+|build\/workflow-runtime\.cjs)$/);
  }
  for (const file of ['dist/cli/bootstrap.js', 'dist/build-id', 'dist/cli/main.js', 'web/dist/index.html', 'build/workflow-runtime.cjs']) {
    assert.ok(files.includes(`package/${file}`), `Missing ${file}`);
  }
  run('npm', ['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', archive], {
    stdio: 'inherit', timeout: 300_000,
  });
  const flow = join(prefix, 'bin/flow');
  assert.equal(run(flow, ['--version']).trim(), metadata.version);
  assert.match(run(flow, ['--help']), /usage:/);
  assert.throws(() => run(flow, ['serve', 'start', 'extra']), /Unexpected serve arguments/);
  const installed = join(prefix, 'lib/node_modules', metadata.name);
  assert.throws(() => run(process.execPath, [join(installed, 'dist/cli/main.js'), '--version']), /internal CLI entry/);
  assert.throws(() => run(flow, ['update', '--force', 'extra']), /usage: flow update/);
  assert.throws(() => run(flow, ['--force', 'update']), /Use flow update/);
  const registry = join(prefix, '.flow-installations', readdirSync(join(prefix, '.flow-installations'))[0]);
  const barrier = join(registry, 'update.json');
  writeFileSync(barrier, JSON.stringify({ pid: process.pid, id: 'smoke', phase: 'replacing', previous: metadata.version }));
  assert.throws(() => run(flow, ['--version']), /startup blocked/);
  rmSync(barrier);

  host = spawn(flow, ['serve', '--port', '0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  hostClosed = once(host, 'close');
  host.stdout.on('data', data => { hostOutput += data; });
  host.stderr.on('data', data => { hostOutput += data; });
  let daemon;
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(host.exitCode, null, hostOutput);
    try { daemon = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  }
  assert.ok(daemon, `Session Host did not start: ${hostOutput}`);
  const request = async (path, options = {}) => {
    const response = await fetch(`${daemon.url}${path}`, {
      ...options, headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response;
  };
  const html = await (await request('/')).text();
  assert.match(html, /<html/);
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, 'Entry Document has no JavaScript asset');
  assert.match((await request(asset)).headers.get('content-type'), /javascript/);
  const runtimeStatus = await (await request('/api/workflow-runtime')).json();
  assert.equal(runtimeStatus.available, true, JSON.stringify(runtimeStatus));
  await request('/api/command', { method: 'POST', body: JSON.stringify({ type: 'create', scope: cwd, backend: 'fake' }) });
  const sessions = await (await request('/api/sessions')).json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].backend, 'fake');
  assert.match(run(flow, ['list']), /fake/);

  const tuiExit = async () => {
    const tui = spawn(flow, ['tui', '--backend', 'fake', '--scope', cwd], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(tui, 'close');
    const timer = setTimeout(() => tui.kill('SIGTERM'), 15000);
    try {
      await once(tui.stdout, 'data');
      const owner = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8'));
      if (owner.mode === 'embedded') assert.throws(() => run(flow, ['serve', 'restart']), /background-owned/);
      tui.stdin.write('\u0003');
      const [code] = await exited;
      assert.equal(code, 0);
      return owner;
    } finally { clearTimeout(timer); tui.kill('SIGTERM'); }
  };
  assert.equal((await tuiExit()).instanceId, daemon.instanceId);
  assert.match(run(flow, ['serve', 'status']), new RegExp(`Running version: ${metadata.version}`));
  assert.throws(() => run(flow, ['serve', 'restart']), /background-owned/);
  await request('/api/command', { method: 'POST', body: JSON.stringify({ type: 'send', sessionId: sessions[0].id, text: 'hold turn', when: 'now' }) });
  assert.throws(() => run(flow, ['serve', 'stop']), /active work/);
  const stream = await fetch(`${daemon.url}/api/sessions/${sessions[0].id}/events?since=0`, { headers: { authorization: `Bearer ${daemon.token}` }, signal: AbortSignal.timeout(15000) });
  assert.equal(stream.status, 200);
  run(flow, ['serve', 'stop', '--force']);
  await stream.body.cancel();
  await hostClosed;
  host = undefined;
  run(flow, ['serve', 'start', '--port', '0']);
  const background = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8'));
  assert.equal(background.mode, 'background');
  assert.equal(statSync(join(state, 'host.log')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(state, 'host.log'), 'utf8'), /Session Host listening/);
  assert.equal(background.settings.port, 0);
  assert.equal(background.settings.cwd, cwd);
  const conflictRoot = join(temp, 'conflict');
  assert.throws(() => run(flow, ['serve', '--port', new URL(background.url).port], { env: { ...env, FLOW_STATE_DIR: conflictRoot } }), /EADDRINUSE/);
  assert.throws(() => run(flow, ['serve', 'start', '--port', new URL(background.url).port], { env: { ...env, FLOW_STATE_DIR: conflictRoot } }), /see .*host\.log/);
  assert.match(readFileSync(join(conflictRoot, 'host.log'), 'utf8'), /EADDRINUSE/);
  assert.throws(() => readFileSync(join(conflictRoot, 'daemon.json')), { code: 'ENOENT' });
  assert.ok(!readdirSync(conflictRoot).some(name => name.startsWith('host.lock')));
  assert.throws(() => run(flow, ['serve', 'restart'], { env: { ...env, FLOW_OIDC_ISSUER: 'https://different.invalid' } }), /matching OIDC/);
  assert.match(run(flow, ['serve', 'status']), /background/);
  run(flow, ['serve', 'restart'], { cwd: temp, env: { ...env, FLOW_STATE_DIR: 'state' } });
  const restarted = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8'));
  assert.notEqual(restarted.instanceId, background.instanceId);
  assert.equal(restarted.settings.port, 0);
  assert.match(run(flow, ['list']), /dormant/);
  assert.throws(() => run(flow, ['--backend', 'fake', 'hello']), /already owns/);
  run(flow, ['serve', 'stop']);
  const embedded = await tuiExit();
  assert.equal(embedded.mode, 'embedded');
  assert.throws(() => readFileSync(join(state, 'daemon.json')), { code: 'ENOENT' });

  const runtime = join(prefix, 'lib/node_modules', metadata.name, 'build/workflow-runtime.cjs');
  const child = spawn(process.execPath, [runtime, '--guest'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    child.stdin.write(JSON.stringify({ kind: 'typescript', scope: cwd, code: 'return input + 1;', input: 41,
      inputType: 'number', outputType: 'number', secrets: {}, timeout: 10_000 }) + '\n');
    const [code] = await closed;
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), { output: 42 });
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
  console.log('Packed install: host control, TUI ownership, version, web assets, fake backend, and Workflow runtime passed.');
} finally {
  if (host) {
    host.kill('SIGTERM');
    const timer = setTimeout(() => host.kill('SIGKILL'), 5000);
    try { await hostClosed; } finally { clearTimeout(timer); }
  }
  try { run(join(prefix, 'bin/flow'), ['serve', 'stop', '--force']); } catch {}
  rmSync(temp, { recursive: true, force: true });
}
