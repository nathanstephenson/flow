import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchWorker, type WorkerLaunchOptions } from '../src/backend/worker/launcher.ts';
import { WorkflowAuthoringScopeChecks } from '../src/daemon/workflow-authoring-scope-checks.ts';
import { workflowAuthoringDirectory, workflowAuthoringScope, workflowAuthoringScopePath } from '../src/daemon/workflow-authoring-scope.ts';
import { includedProjects } from '../src/daemon/projects.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeReaders() {
  const readers: Array<{ child: EventEmitter; stops: number; release: () => void; options: WorkerLaunchOptions }> = [];
  const launch: typeof launchWorker = options => {
    const exited = deferred();
    const stopped = deferred();
    const child = new EventEmitter();
    Object.assign(child, { send: (_request: unknown, callback: (error: Error | null) => void) => { callback(null); return true; } });
    const reader = { child, stops: 0, options: options!, release: () => { stopped.resolve(); exited.resolve(); } };
    readers.push(reader);
    return {
      child: child as ChildProcess, exited: exited.promise, diagnostics: () => '',
      stop: async () => { reader.stops++; await stopped.promise; await exited.promise; },
    };
  };
  return { readers, checks: new WorkflowAuthoringScopeChecks({ linuxSync: false, launch }) };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-authoring-scope-')));
  const scope = join(root, 'scope');
  mkdirSync(scope);
  return { root, scope, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('path selection preserves Project membership and normalization without checking existence', () => {
  const root = join(tmpdir(), 'missing-flow-project-root');
  const entries = [' api/./ ', 'api', '', '/outside/./', '/', '~/flow-missing-project'];
  const config = { projectRoot: () => root, projectInclude: () => entries };
  for (const project of includedProjects(root, entries)) {
    assert.equal(workflowAuthoringScopePath(config, '/fallback', project.path), project.path);
  }
  assert.equal(workflowAuthoringScopePath(config, '/fallback'), root);
  assert.throws(() => workflowAuthoringScopePath(config, '/fallback', `${root}/api/`), /not opted in/);
  assert.throws(() => workflowAuthoringScope(config, '/fallback', `${root}/api`), /not opted in/);
  const noRoot = { ...config, projectRoot: () => undefined };
  assert.equal(workflowAuthoringScopePath(noRoot, '~'), homedir());
  assert.equal(workflowAuthoringScopePath(noRoot, '/fallback', '/outside'), '/outside');
  assert.throws(() => workflowAuthoringScopePath(noRoot, '/fallback', `${root}/api`), /not opted in/);
});

for (const linuxSync of [true, false]) {
  test(`canonical aliases and replaced roots are checked (${linuxSync ? 'Linux fast path' : 'reader'})`, async () => {
    const f = fixture();
    const checks = new WorkflowAuthoringScopeChecks({ linuxSync });
    try {
      const alias = join(f.root, 'alias');
      symlinkSync(f.scope, alias);
      const directory = await checks.read(alias);
      assert.deepEqual(directory, workflowAuthoringDirectory(f.scope));
      await checks.check(directory);
      await assert.rejects(checks.check({ ...directory, path: alias }), /Scope changed/);
      renameSync(f.scope, join(f.root, 'original'));
      mkdirSync(f.scope);
      await assert.rejects(checks.check(directory), /Scope changed/);
      rmSync(f.scope, { recursive: true });
      symlinkSync(join(f.root, 'original'), f.scope);
      await assert.rejects(checks.check(directory), /Scope changed/);
      rmSync(f.scope);
      renameSync(join(f.root, 'original'), f.scope);
      await checks.check(directory);
      writeFileSync(join(f.root, 'file'), 'not a directory');
      await assert.rejects(checks.read(join(f.root, 'file')));
      await assert.rejects(checks.read(join(f.root, 'missing')), /Scope unavailable/);
      renameSync(f.scope, join(f.root, 'gone'));
      await assert.rejects(checks.check(directory), /Scope changed/);
    } finally { await checks.shutdown(); f.cleanup(); }
    assert.equal(checks.hasActiveWork(), false);
    await assert.rejects(checks.read(f.scope), /unavailable/);
  });
}

test('stalled reader response is bounded but its actual stop remains owned', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeReaders();
  const pending = f.checks.read('/stalled');
  const rejected = assert.rejects(pending, /unavailable/);
  assert.equal(f.checks.hasActiveWork(), true);
  t.mock.timers.tick(4999);
  assert.equal(f.readers[0]!.stops, 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.readers[0]!.stops, 1);
  assert.equal(f.checks.hasActiveWork(), true);
  let closed = false;
  const shutdown = f.checks.shutdown().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  f.readers[0]!.release();
  await shutdown;
  assert.equal(f.checks.hasActiveWork(), false);
  assert.equal(f.readers[0]!.stops, 1);
});

test('capacity includes timed-out readers until cleanup; excess requests are not queued', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeReaders();
  const rejected = Array.from({ length: 4 }, (_, index) => assert.rejects(f.checks.read(`/stalled-${index}`), /unavailable/));
  await assert.rejects(f.checks.read('/excess'), /unavailable/);
  assert.equal(f.readers.length, 4);
  t.mock.timers.tick(5000);
  await Promise.all(rejected);
  await assert.rejects(f.checks.read('/still-full'), /unavailable/);
  assert.equal(f.readers.length, 4);
  for (const reader of f.readers) reader.release();
  await f.checks.shutdown();
});

test('concurrent identical checks share only pending work and refresh after settlement', async () => {
  const f = fakeReaders();
  const directory = { path: '/scope', identity: '1:2' };
  const pending = Array.from({ length: 16 }, () => f.checks.check(directory));
  assert.equal(f.readers.length, 1);
  f.readers[0]!.child.emit('message', { ok: true, result: directory });
  await Promise.all(pending);
  f.readers[0]!.release();
  await new Promise(resolve => setImmediate(resolve));
  const fresh = assert.rejects(f.checks.check(directory), /Scope changed/);
  assert.equal(f.readers.length, 2);
  f.readers[1]!.child.emit('message', { ok: true, result: { ...directory, identity: '1:3' } });
  await fresh;
  f.readers[1]!.release(); await f.checks.shutdown();
});

test('shutdown cancels pending callers and waits for helper cleanup', async () => {
  const f = fakeReaders();
  const rejected = assert.rejects(f.checks.read('/stalled'), /unavailable/);
  const shutdown = f.checks.shutdown();
  assert.equal(shutdown, f.checks.shutdown());
  await rejected;
  assert.equal(f.checks.hasActiveWork(), true);
  await assert.rejects(f.checks.read('/new'), /unavailable/);
  assert.equal(f.readers.length, 1);
  f.readers[0]!.release();
  await shutdown;
  assert.equal(f.checks.hasActiveWork(), false);
});

test('successful response retains cleanup ownership and uses neutral cwd with no preload environment', async () => {
  const f = fakeReaders();
  const pending = f.checks.read('/stalled');
  const reader = f.readers[0]!;
  assert.equal(reader.options.cwd, '/');
  assert.deepEqual(reader.options.execArgv, ['--experimental-strip-types']);
  for (const [key, value] of Object.entries(reader.options.env!)) {
    assert.equal(value, key === 'FLOW_WORKFLOW_AUTHORING_SCOPE_READER' ? '1' : undefined);
  }
  reader.child.emit('message', { ok: true, result: { path: '/canonical', identity: '1:2' } });
  assert.deepEqual(await pending, { path: '/canonical', identity: '1:2' });
  assert.equal(f.checks.hasActiveWork(), true);
  reader.release();
  await f.checks.shutdown();
});

test('untrusted paths, identities, and helper results are bounded and checked', async () => {
  const f = fakeReaders();
  for (const path of ['', '/bad\0path', 'x'.repeat(4097)]) await assert.rejects(f.checks.read(path));
  for (const directory of [null, { path: 'relative', identity: '1:2' }, { path: '/a/../b', identity: '1:2' },
    { path: '/a', identity: 'x'.repeat(4097) }]) {
    await assert.rejects(f.checks.check(directory as never));
  }
  assert.equal(f.readers.length, 0);
  for (const result of [null, { path: '/a', identity: 'bad' }, { path: '/different', identity: '1:2' }, { path: '/a', identity: '1:3' }]) {
    const rejected = assert.rejects(f.checks.check({ path: '/a', identity: '1:2' }), /Scope changed/);
    const reader = f.readers.at(-1)!;
    reader.child.emit('message', { ok: true, result });
    await rejected;
    reader.release();
    await new Promise(resolve => setImmediate(resolve));
  }
  await f.checks.shutdown();
});

test('helper startup failure does not drop cleanup ownership', async () => {
  const f = fakeReaders();
  const rejected = assert.rejects(f.checks.read('/scope'), /unavailable/);
  const reader = f.readers[0]!;
  reader.child.emit('error', new Error('spawn failed'));
  await rejected;
  assert.equal(f.checks.hasActiveWork(), true);
  assert.equal(reader.stops, 1);
  reader.release();
  await f.checks.shutdown();
});

test('reader entry refuses IPC without its guarded environment', { timeout: 5000 }, async () => {
  const helper = launchWorker({
    entry: fileURLToPath(new URL('../src/daemon/workflow-authoring-scope-reader.ts', import.meta.url)),
    execArgv: ['--experimental-strip-types'], cwd: '/', shutdownTimeoutMs: 0,
    env: { FLOW_WORKFLOW_AUTHORING_SCOPE_READER: undefined },
  });
  try {
    await helper.exited;
    assert.equal(helper.child.exitCode, 1);
  } finally { await helper.stop(async () => {}); }
});

test('reader imports only builtins', () => {
  const source = readFileSync(new URL('../src/daemon/workflow-authoring-scope-reader.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]!);
  assert.ok(imports.length > 0);
  assert.ok(imports.every(path => path.startsWith('node:')));
  assert.doesNotMatch(source, /import\(/);
});
