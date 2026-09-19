import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalRoot, installation, updateEligible, type Barrier, type Lease } from '../src/cli/install-guard.ts';
import { processAlive as alive } from '../src/cli/host-control.ts';

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

const bootstrap = readFileSync(resolve('src/cli/bootstrap.ts'), 'utf8').replace('    const lease = await install.register', `
    if (process.env.TEST_PAUSE) {
      const fs = await import('node:fs');
      fs.writeFileSync(process.env.TEST_PAUSE, 'ready');
      while (fs.existsSync(process.env.TEST_PAUSE)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const lease = await install.register`);
const bundle = await build({ stdin: { contents: bootstrap, resolveDir: resolve('src/cli'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, define: { FLOW_BUILD_ID: '"test-build"' } });
const hostCode = `
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export async function runCli() {
const root = process.env.FLOW_STATE_DIR;
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
if (process.argv[2] === '--version') { console.log(version); }
else {
 mkdirSync(root, { recursive: true });
 if (process.env.TEST_RESTORE_FAIL === 'both' || (process.env.TEST_RESTORE_FAIL === 'latest' && version === '2.0.0')) { console.error('synthetic host restore failure'); process.exit(1); }
 const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
 const settings = { port: Number(value('--port')), address: value('--address'), cwd: process.cwd(), oidc: createHash('sha256').update(JSON.stringify(['ISSUER','CLIENT_ID','CLIENT_SECRET','PUBLIC_APP_URL'].map(k => process.env['FLOW_OIDC_' + k]?.trim() ?? ''))).digest('hex') };
 let identity;
 const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer test') { res.writeHead(401); res.end('invalid bearer'); return; }
  if (req.url === '/api/host') { const { token, ...status } = identity; res.end(JSON.stringify(status)); return; }
  let body = ''; req.on('data', data => body += data); req.on('end', () => {
   if (process.env.TEST_BUSY && !JSON.parse(body).force) { res.writeHead(409); res.end('active work'); return; }
   res.end('{}'); server.close(() => { unlinkSync(join(root, 'daemon.json')); process.exit(0); });
  });
 });
 server.listen(settings.port, settings.address, () => {
  identity = { pid: process.pid, instanceId: randomUUID(), version, url: 'http://127.0.0.1:' + server.address().port, token: 'test', mode: process.env.TEST_MODE ?? 'background', settings };
  writeFileSync(join(root, 'daemon.json'), JSON.stringify(identity));
 });
}
}
`;
async function until(check: () => boolean) { for (let n = 0; n < 150; n++) { if (check()) return; await delay(30); } throw new Error('Test timed out'); }
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'flow-update-test-'));
  const prefix = join(temp, 'prefix'), slot = join(prefix, 'lib/node_modules/@nathanstephenson/flow'), root = join(temp, 'state');
  mkdirSync(join(slot, 'dist/cli'), { recursive: true }); mkdirSync(root); mkdirSync(join(temp, 'bin'));
  writeFileSync(join(slot, 'package.json'), JSON.stringify({ name: '@nathanstephenson/flow', version: '1.2.3', type: 'module' }));
  writeFileSync(join(slot, 'dist/build-id'), 'test-build');
  writeFileSync(join(slot, 'dist/cli/bootstrap.js'), bundle.outputFiles[0]!.text);
  writeFileSync(join(slot, 'dist/cli/application.js'), hostCode);
  const npm = join(temp, 'bin/npm');
  writeFileSync(npm, `#!${process.execPath}\nconst fs = require('node:fs'), p = require('node:path');
const args = process.argv.slice(2), prefix = process.env.TEST_PREFIX, slot = p.join(prefix, 'lib/node_modules/@nathanstephenson/flow');
if (args[0] === 'prefix') console.log(process.env.TEST_WRONG_PREFIX || prefix);
else if (args[0] === 'root') console.log(p.join(process.env.TEST_WRONG_PREFIX || prefix, 'lib/node_modules'));
else {
 fs.appendFileSync(p.join(prefix, 'npm-log'), JSON.stringify(args) + '\\n');
 const latest = args.at(-1).endsWith('@latest');
 if (latest && process.env.TEST_ORPHAN) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'ORPHAN-CORRUPTED'), 2500)", p.join(slot, 'dist/build-id')], { stdio: 'ignore' });
  child.once('spawn', () => process.kill(process.pid, 'SIGTERM'));
  return;
 }
 const finish = () => {
  const version = latest && !process.env.TEST_UNCHANGED ? '2.0.0' : '1.2.3';
  if (process.env.TEST_BAD_BUILD) fs.writeFileSync(p.join(slot, 'dist/build-id'), 'wrong-build');
  fs.writeFileSync(p.join(slot, 'package.json'), JSON.stringify({ name: '@nathanstephenson/flow', version, type: 'module' }));
  fs.writeFileSync(p.join(prefix, 'npm-finished'), 'done');
  if (process.env.TEST_FAIL === 'both' || (latest && process.env.TEST_FAIL === 'latest')) process.exit(1);
 };
 if (process.env.TEST_SLOW) setTimeout(finish, 1500); else finish();
}
`); chmodSync(npm, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, FLOW_STATE_DIR: root, TEST_PREFIX: prefix, PATH: `${join(temp, 'bin')}:${process.env.PATH}` };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) if (key.startsWith('FLOW_OIDC_')) delete env[key as keyof typeof env];
  const children: ChildProcess[] = [];
  const roots = new Set([root]);
  function start(args: string[], extra: Record<string, string> = {}) {
    roots.add(extra.FLOW_STATE_DIR ?? root);
    const child = spawn(process.execPath, [join(slot, 'dist/cli/bootstrap.js'), ...args], { env: { ...env, ...extra }, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = ''; child.stdout!.on('data', data => output += data); child.stderr!.on('data', data => output += data);
    const done = once(child, 'close').then(([code]) => ({ code, output }));
    return { child, done };
  }
  const install = installation(slot);
  const leases = () => readdirSync(install.directory).filter(name => name.startsWith('lease-')).map(name => json<Lease>(join(install.directory, name))!);
  return { temp, prefix, slot, root, env, install, leases, start, async close() {
    for (const stateRoot of roots) {
      const host = json<{ pid: number }>(join(stateRoot, 'daemon.json'));
      if (host) { try { process.kill(host.pid, 'SIGTERM'); } catch {} }
    }
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await delay(100); rmSync(temp, { recursive: true, force: true });
  } };
}

test('ordinary system-global startup skips update registration; self-update refuses', async () => {
  for (const kind of ['shared', 'foreign-owner', 'root']) {
    const f = fixture();
    try {
      rmSync(join(f.prefix, '.flow-installations'), { recursive: true });
      if (kind === 'shared') chmodSync(f.prefix, 0o777);
      else writeFileSync(join(f.slot, 'dist/cli/bootstrap.js'), `process.getuid = () => ${kind === 'root' ? 0 : process.getuid!() + 1};\n` + bundle.outputFiles[0]!.text.replace(/^#!.*\n/, ''));
      const normal = await f.start(['--version']).done;
      assert.equal(normal.code, 0, normal.output); assert.equal(normal.output.trim(), '1.2.3');
      const refused = await f.start(['update']).done;
      assert.equal(refused.code, 1); assert.match(refused.output, /Self-update requires/);
      assert.equal(existsSync(join(f.prefix, '.flow-installations')), false);
      assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
    } finally { await f.close(); }
  }
});

test('npm-link startup uses the source entry without an installation lease', async () => {
  const f = fixture();
  try {
    const source = join(f.temp, 'source');
    renameSync(f.slot, source); symlinkSync(source, f.slot);
    const result = await f.start(['--version']).done;
    assert.equal(result.code, 0, result.output); assert.equal(result.output.trim(), '1.2.3');
    assert.equal(f.leases().length, 0);
    const refused = await f.start(['update']).done;
    assert.equal(refused.code, 1); assert.match(refused.output, /source and npm link are unsupported/);
    assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
  } finally { await f.close(); }
});

test('eligible startup fails closed for corrupt or inaccessible registry records', async () => {
  for (const kind of ['corrupt', 'permissions', 'blocked']) {
    const f = fixture();
    try {
      if (kind === 'corrupt') writeFileSync(f.install.barrierPath, '{invalid');
      if (kind === 'permissions') chmodSync(f.install.directory, 0o755);
      if (kind === 'blocked') {
        rmSync(f.install.directory, { recursive: true });
        writeFileSync(f.install.directory, 'not a directory');
      }
      const result = await f.start(['--version']).done;
      assert.equal(result.code, 1, result.output);
      assert.doesNotMatch(result.output, /^1\.2\.3\s*$/);
    } finally { await f.close(); }
  }
});

test('a bootstrap paused before registration rejects a replaced build', async () => {
  const f = fixture();
  try {
    const pause = join(f.temp, 'paused');
    const waiting = f.start(['--version'], { TEST_PAUSE: pause });
    await until(() => existsSync(pause));
    writeFileSync(join(f.slot, 'dist/build-id'), 'replacement-build');
    writeFileSync(join(f.slot, 'dist/cli/application.js'), "console.log('UNGUARDED MAIN');");
    rmSync(pause);
    const result = await waiting.done;
    assert.equal(result.code, 1); assert.match(result.output, /replaced during startup/);
    assert.doesNotMatch(result.output, /UNGUARDED MAIN/);
    assert.equal(f.leases().length, 0);
  } finally { await f.close(); }
});

test('a previously loaded bootstrap in another root cannot register during replacement', async () => {
  const f = fixture();
  try {
    const pause = join(f.temp, 'paused');
    const waiting = f.start(['--version'], { TEST_PAUSE: pause, FLOW_STATE_DIR: join(f.temp, 'other-root') });
    await until(() => existsSync(pause));
    const updating = f.start(['update'], { TEST_SLOW: '1' });
    await until(() => existsSync(join(f.prefix, 'npm-log')));
    rmSync(pause);
    const result = await waiting.done;
    assert.equal(result.code, 1); assert.match(result.output, /startup blocked/);
    assert.equal((await updating.done).code, 0);
  } finally { await f.close(); }
});

test('updater death after npm starts leaves a persistent startup barrier', async () => {
  const f = fixture();
  try {
    const updating = f.start(['update'], { TEST_SLOW: '1' });
    await until(() => existsSync(join(f.prefix, 'npm-log')));
    assert.equal(json<Barrier>(f.install.barrierPath)?.phase, 'replacing');
    updating.child.kill('SIGKILL');
    await until(() => existsSync(join(f.prefix, 'npm-finished')));
    await updating.done;
    assert.equal(json<{ version: string }>(join(f.slot, 'package.json'))?.version, '2.0.0');
    for (const args of [['--version'], ['update']]) {
      const blocked = await f.start(args).done;
      assert.equal(blocked.code, 1); assert.match(blocked.output, /startup blocked/);
    }
    assert.equal(existsSync(f.install.barrierPath), true);
    assert.equal(readFileSync(join(f.prefix, 'npm-log'), 'utf8').trim().split('\n').length, 1);
  } finally { await f.close(); }
});

test('permission errors do not classify an owner as dead', context => {
  context.mock.method(process, 'kill', () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
  assert.throws(() => alive(12345), /not permitted/);
});

test('registry rejects old builds, concurrent roots, invalid owners, and dead update records', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.install.register('old-build', f.root, ['list']), /replaced/);
    const lease = await f.install.register('test-build', '/other-root', ['tui']);
    const refused = await f.start(['update']).done;
    assert.equal(refused.code, 1); assert.match(refused.output, /other Flow/);
    assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
    lease.release();
    writeFileSync(join(f.install.directory, 'lease-invalid.json'), JSON.stringify({ pid: -1, id: 'bad', root: '/', args: [] }));
    await assert.rejects(f.install.beginUpdate(lease, '1.2.3'), /Invalid/);
    rmSync(join(f.install.directory, 'lease-invalid.json'));
    const exited = spawn(process.execPath, ['-e', '']); await once(exited, 'exit');
    writeFileSync(f.install.barrierPath, JSON.stringify({ pid: exited.pid!, id: 'dead', phase: 'replacing', previous: '1.2.3' }));
    const blocked = await f.start(['--version']).done;
    assert.equal(blocked.code, 1); assert.match(blocked.output, /startup blocked/);
  } finally { await f.close(); }
});

test('only a bound one-use capability passes the update barrier', async () => {
  const f = fixture();
  try {
    writeFileSync(f.install.barrierPath, JSON.stringify({ pid: process.pid, id: 'owner', phase: 'restoring', previous: '1.2.3', capability: { token: 'secret', root: f.root, args: ['--version'] } }));
    await assert.rejects(f.install.register('test-build', '/wrong-root', ['--version'], 'secret'), /blocked/);
    await assert.rejects(f.install.register('test-build', f.root, ['serve'], 'secret'), /blocked/);
    const lease = await f.install.register('test-build', f.root, ['--version'], 'secret'); lease.release();
    await assert.rejects(f.install.register('test-build', f.root, ['--version'], 'secret'), /blocked/);
  } finally { await f.close(); }
});

test('latest install and exact rollback use only the verified prefix', async () => {
  for (const failure of ['', 'latest', 'both']) {
    const f = fixture();
    try {
      const result = await f.start(['update'], { TEST_FAIL: failure }).done;
      assert.equal(result.code, failure ? 1 : 0, result.output);
      const calls = readFileSync(join(f.prefix, 'npm-log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(calls[0], ['install', '--global', '--prefix', f.prefix, '@nathanstephenson/flow@latest']);
      if (failure) assert.deepEqual(calls[1], ['install', '--global', '--prefix', f.prefix, '@nathanstephenson/flow@1.2.3']);
      assert.equal(existsSync(f.install.barrierPath), failure === 'both');
      assert.match(result.output, failure === 'both' ? /recovery failed.*startup remains blocked/s : failure ? /Reinstalled and verified 1.2.3/ : /1.2.3 → 2.0.0/);
      if (failure === 'both') assert.equal((await f.start(['--version']).done).code, 1);
    } finally { await f.close(); }
  }
});

test('replacement blocks new clients, hosts in another state root, and another updater', async () => {
  const f = fixture();
  try {
    const updating = f.start(['update'], { TEST_SLOW: '1' });
    await until(() => json<Barrier>(f.install.barrierPath)?.phase === 'replacing');
    for (const args of [['--version'], ['serve', '--background-host'], ['update']]) {
      const blocked = await f.start(args, { FLOW_STATE_DIR: join(f.temp, 'other-state') }).done;
      assert.equal(blocked.code, 1); assert.match(blocked.output, /startup blocked/);
    }
    assert.equal((await updating.done).code, 0);
  } finally { await f.close(); }
});

test('wrong npm prefix, source, link, unsafe permissions, and extra arguments refuse mutation', async () => {
  const f = fixture();
  try {
    for (const args of [['update', '1.0.0'], ['update', '--force', '--force'], ['update', '--unknown']]) assert.match((await f.start(args).done).output, /usage:/);
    const other = join(f.temp, 'other'); mkdirSync(join(other, 'lib/node_modules'), { recursive: true });
    assert.match((await f.start(['update'], { TEST_WRONG_PREFIX: other }).done).output, /different installation/);
    assert.throws(() => installation(f.temp), /global npm/);
    chmodSync(f.prefix, 0o777); assert.throws(() => installation(f.slot), /private installation/); chmodSync(f.prefix, 0o755);
    const linked = join(f.temp, 'linked/lib/node_modules/@nathanstephenson/flow'); mkdirSync(resolve(linked, '..'), { recursive: true }); symlinkSync(f.slot, linked);
    assert.throws(() => installation(linked), /private installation/);
    assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
  } finally { await f.close(); }
});

test('busy refusal leaves selected host untouched; force restores settings with a new PID', async () => {
  const f = fixture();
  try {
    const host = f.start(['serve', '--background-host', '--port', '0', '--address', '127.0.0.1'], { TEST_BUSY: '1' });
    await until(() => existsSync(join(f.root, 'daemon.json')));
    const before = json<{ pid: number; settings: unknown }>(join(f.root, 'daemon.json'))!;
    const refused = await f.start(['update']).done;
    assert.equal(refused.code, 1); assert.match(refused.output, /active work/); assert.equal(existsSync(f.install.barrierPath), false);
    assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
    assert.equal(json<{ pid: number }>(join(f.root, 'daemon.json'))!.pid, before.pid);
    const result = await f.start(['update', '--force']).done;
    assert.equal(result.code, 0, result.output);
    const after = json<{ pid: number; settings: unknown }>(join(f.root, 'daemon.json'))!;
    assert.notEqual(after.pid, before.pid); assert.deepEqual(after.settings, before.settings);
    assert.equal((await host.done).code, 0);
  } finally { await f.close(); }
});

test('OIDC mismatch and an unregistered selected host refuse before stopping', async () => {
  const f = fixture();
  try {
    f.start(['serve', '--background-host', '--port', '0', '--address', '127.0.0.1']);
    await until(() => existsSync(join(f.root, 'daemon.json')));
    assert.match((await f.start(['update'], { FLOW_OIDC_ISSUER: 'https://different.invalid' }).done).output, /matching OIDC/);
    const host = json<{ pid: number }>(join(f.root, 'daemon.json'))!;
    const lease = f.leases().find(lease => lease.pid === host.pid)!;
    rmSync(join(f.install.directory, `lease-${lease.id}.json`));
    assert.match((await f.start(['update']).done).output, /pre-guard Flow/);
    assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
  } finally { await f.close(); }
});

test('an already-running host in another root blocks update', async () => {
  const f = fixture();
  try {
    const other = join(f.temp, 'other-root'); mkdirSync(other);
    f.start(['serve', '--background-host', '--port', '0', '--address', '127.0.0.1'], { FLOW_STATE_DIR: other });
    await until(() => existsSync(join(other, 'daemon.json')));
    assert.match((await f.start(['update']).done).output, /other Flow/);
    assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
  } finally { await f.close(); }
});

test('unchanged versions and failed fresh-process verification are reported accurately', async () => {
  for (const extra of [{ TEST_UNCHANGED: '1' }, { TEST_BAD_BUILD: '1' }] as Record<string, string>[]) {
    const f = fixture();
    try {
      const result = await f.start(['update'], extra).done;
      assert.equal(result.code, extra.TEST_BAD_BUILD ? 1 : 0, result.output);
      assert.match(result.output, extra.TEST_BAD_BUILD ? /recovery failed/ : /already at 1.2.3/);
      assert.equal(existsSync(f.install.barrierPath), !!extra.TEST_BAD_BUILD);
    } finally { await f.close(); }
  }
});

test('restoration failure triggers rollback; failed rollback restoration keeps the barrier', async () => {
  for (const failure of ['latest', 'both']) {
    const f = fixture();
    try {
      f.start(['serve', '--background-host', '--port', '0', '--address', '127.0.0.1']);
      await until(() => existsSync(join(f.root, 'daemon.json')));
      const result = await f.start(['update'], { TEST_RESTORE_FAIL: failure }).done;
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, failure === 'both' ? /recovery failed/ : /Reinstalled and verified 1.2.3/);
      assert.equal(existsSync(f.install.barrierPath), failure === 'both');
      assert.match(readFileSync(join(f.root, 'host.log'), 'utf8'), /synthetic host restore failure/);
      assert.equal(statSync(join(f.root, 'host.log')).mode & 0o777, 0o600);
    } finally { await f.close(); }
  }
});

test('mutex reaps only confirmed-dead owners and serializes live callers', async () => {
  const f = fixture();
  try {
    const dead = spawn(process.execPath, ['-e', '']); await once(dead, 'exit');
    const mutex = join(f.install.directory, 'mutex');
    mkdirSync(mutex); writeFileSync(join(mutex, 'dead.json'), JSON.stringify({ pid: dead.pid, id: 'dead' }));
    const order: number[] = [];
    await Promise.all([1, 2].map(async n => { const lease = await f.install.register('test-build', f.root, ['list']); order.push(n); lease.release(); }));
    assert.deepEqual(order.sort(), [1, 2]);
    mkdirSync(mutex); writeFileSync(join(mutex, 'a.json'), JSON.stringify({ pid: process.pid, id: 'a' }));
    await assert.rejects(f.install.register('test-build', f.root, ['list']), /busy/);
    assert.equal(existsSync(join(mutex, 'a.json')), true);
  } finally { await f.close(); }
});

test('failed npm descendants are stopped before rollback unblocks startup', async () => {
  const f = fixture();
  try {
    const result = await f.start(['update'], { TEST_ORPHAN: '1' }).done;
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Reinstalled and verified/);
    assert.equal(existsSync(f.install.barrierPath), false);
    await delay(2700);
    assert.equal(readFileSync(join(f.slot, 'dist/build-id'), 'utf8'), 'test-build');
    assert.equal((await f.start(['--version']).done).output.trim(), '1.2.3');
  } finally { await f.close(); }
});

test('uncertain npm process cleanup blocks recovery and startup', async () => {
  const f = fixture();
  try {
    const entry = join(f.slot, 'dist/cli/bootstrap.js');
    writeFileSync(entry, `const kill = process.kill; process.kill = (pid, signal) => { if (pid < 0) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return kill(pid, signal); };\n` + bundle.outputFiles[0]!.text.replace(/^#!.*\n/, ''));
    const result = await f.start(['update']).done;
    assert.equal(result.code, 1);
    assert.match(result.output, /Cannot confirm npm descendants stopped/);
    assert.equal(readFileSync(join(f.prefix, 'npm-log'), 'utf8').trim().split('\n').length, 1);
    assert.equal(existsSync(f.install.barrierPath), true);
    assert.equal((await f.start(['--version']).done).code, 1);
  } finally { await f.close(); }
});

test('permission changes cannot bypass a previously guarded installation', async () => {
  const f = fixture();
  try {
    writeFileSync(f.install.barrierPath, JSON.stringify({ pid: process.pid, id: 'owner', phase: 'replacing', previous: '1.2.3' }));
    chmodSync(f.slot, 0o775);
    const result = await f.start(['--version']).done;
    assert.equal(result.code, 1, result.output);
    assert.equal(existsSync(f.install.barrierPath), true);
  } finally { await f.close(); }
});

test('new state roots resolve symlinked ancestors without creating directories', async () => {
  const f = fixture();
  try {
    const alias = join(f.temp, 'alias');
    symlinkSync(f.root, alias);
    const pending = join(alias, 'new-state');
    assert.equal(canonicalRoot(pending), join(f.root, 'new-state'));
    const lease = await f.install.register('test-build', pending, ['list']);
    assert.equal(lease.root, join(f.root, 'new-state'));
    assert.equal(existsSync(pending), false);
    lease.release();
  } finally { await f.close(); }
});

test('first background start beneath a symlink remains eligible for update and restoration', async () => {
  const f = fixture();
  try {
    const alias = join(f.temp, 'alias');
    symlinkSync(f.root, alias);
    const root = join(alias, 'new-state');
    const extra = { FLOW_STATE_DIR: root };
    f.start(['serve', '--background-host', '--port', '0', '--address', '127.0.0.1'], extra);
    await until(() => existsSync(join(root, 'daemon.json')));
    const result = await f.start(['update'], extra).done;
    assert.equal(result.code, 0, result.output);
    assert.equal(json<{ version: string }>(join(root, 'daemon.json'))?.version, '2.0.0');
  } finally { await f.close(); }
});

test('private prefixes require protected ancestors, permitting trusted sticky directories', async () => {
  const f = fixture();
  try {
    assert.equal(updateEligible(f.slot), true);
    chmodSync(f.temp, 0o777);
    assert.equal(updateEligible(f.slot), false);
    chmodSync(f.temp, 0o1777);
    assert.equal(updateEligible(f.slot), true);
  } finally { await f.close(); }
});

test('foreground and embedded hosts are never stopped', async () => {
  for (const mode of ['foreground', 'embedded']) {
    const f = fixture();
    try {
      f.start(['serve', '--background-host', '--port', '0', '--address', '127.0.0.1'], { TEST_MODE: mode });
      await until(() => existsSync(join(f.root, 'daemon.json')));
      assert.match((await f.start(['update', '--force']).done).output, /Only a background-owned Session Host/);
      assert.equal(existsSync(join(f.prefix, 'npm-log')), false);
    } finally { await f.close(); }
  }
});
