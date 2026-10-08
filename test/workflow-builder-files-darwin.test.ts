import assert from 'node:assert/strict';
import { it } from 'node:test';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { open, type FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWorker } from '../src/backend/worker/launcher.ts';
import { constants, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowBuilderFiles, probeDarwinNoFollowAny } from '../src/daemon/workflow-builder-files.ts';

const darwin = process.platform === 'darwin';
// Inspect ownership only for lifecycle assertions, not to alter reader policy.
type ReaderOwner = { helpers: Set<{ child: ChildProcess; exited: Promise<void> }>; root: FileHandle };
async function pausedHelpers(files: WorkflowBuilderFiles, count: number): Promise<ReaderOwner> {
  const owner = files as unknown as ReaderOwner;
  const paused = new Set<ChildProcess>();
  for (let i = 0; i < 1000; i++) {
    for (const helper of owner.helpers) if (!paused.has(helper.child)) {
      process.kill(helper.child.pid!, 'SIGSTOP'); paused.add(helper.child);
    }
    if (owner.helpers.size === count) return owner;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Disposable readers did not start');
}
async function readerResponse(root: FileHandle, cwd: string, request: { scope: string; path: string; operation: string }): Promise<unknown> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  env.FLOW_WORKFLOW_BUILDER_READER = '1';
  const helper = launchWorker({ entry: fileURLToPath(new URL('../src/daemon/workflow-builder-reader.ts', import.meta.url)),
    execArgv: ['--experimental-strip-types'], cwd, env, stdioFds: [root.fd], shutdownTimeoutMs: 0 });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Reader did not respond')), 5000);
      helper.child.once('error', reject);
      helper.child.once('message', resolve);
      void helper.exited.then(() => reject(new Error('Reader exited before responding')));
      helper.child.send(request, error => { if (error) reject(error); });
    });
  } finally { clearTimeout(timer); await helper.stop(async () => {}); }
}
function fixture() {
  // macOS /tmp is itself a symlink. The production API deliberately refuses aliases.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-reader-test-')));
  const scope = join(root, 'scope');
  const state = join(root, 'state');
  mkdirSync(scope); mkdirSync(state);
  return { root, scope, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

it('the kernel guard fails closed when flags are ignored or only the leaf is guarded', async () => {
  await assert.rejects(probeDarwinNoFollowAny(0), /Scope is unavailable/);
  await assert.rejects(probeDarwinNoFollowAny(constants.O_NOFOLLOW), /Scope is unavailable/);
  if (process.platform === 'linux') await assert.rejects(probeDarwinNoFollowAny(), /Scope is unavailable/);
});

it('Scope identity comes from the pinned root and remains available after close', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  try {
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    const owner = files as unknown as ReaderOwner;
    const stat = await owner.root.stat({ bigint: true });
    assert.equal(files.scopeIdentity, `${stat.dev}:${stat.ino}`);
    await files.checkScope();
    const identity = files.scopeIdentity;
    renameSync(f.scope, f.scope + '-old'); mkdirSync(f.scope);
    assert.equal(files.scopeIdentity, identity);
    await assert.rejects(files.checkScope(), /reference unavailable/);
    await files.close();
    assert.equal(files.scopeIdentity, identity);
    await assert.rejects(files.checkScope(), /reference unavailable/);
  } finally { await files?.close(); f.cleanup(); }
});

it('Darwin kernel supports all-ancestor no-follow, read/list and credential/protected filtering', { skip: !darwin }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  try {
    await probeDarwinNoFollowAny();
    mkdirSync(join(f.scope, 'nested'));
    mkdirSync(join(f.scope, 'private-state'));
    writeFileSync(join(f.scope, 'ok'), 'reference');
    writeFileSync(join(f.scope, 'nested', 'ok'), 'nested reference');
    for (const name of ['.env', '.env.local', '.ssh', 'certificate.pem', 'mcp.json', 'token']) {
      writeFileSync(join(f.scope, name), 'credential');
    }
    writeFileSync(join(f.scope, 'private-state', 'data'), 'protected');
    writeFileSync(join(f.root, 'outside'), 'outside');
    writeFileSync(join(f.scope, 'huge'), 'x'.repeat(128_001));
    writeFileSync(join(f.scope, 'limit'), 'x'.repeat(128_000));
    symlinkSync('ok', join(f.scope, 'leaf'));
    symlinkSync('nested', join(f.scope, 'ancestor'));
    symlinkSync(f.state, join(f.scope, 'state-link'));
    symlinkSync(f.scope, join(f.root, 'alias'));
    linkSync(join(f.root, 'outside'), join(f.scope, 'hardlink'));
    execFileSync('/usr/bin/mkfifo', [join(f.scope, 'pipe')]);
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    files.protect(join(f.scope, 'private-state'));
    assert.equal(await files.read('ok'), 'reference');
    assert.equal(await files.read('nested/ok'), 'nested reference');
    assert.equal(await files.read('nested/../ok'), 'reference');
    assert.equal((await files.read('limit')).length, 128_000);
    assert.equal(await files.list('nested'), 'ok');
    for (const path of ['../outside', 'leaf', 'ancestor/ok', 'state-link/token', 'pipe', 'hardlink', 'huge', '.env', 'certificate.pem', 'private-state/data']) {
      await assert.rejects(files.read(path), /reference unavailable/);
    }
    for (const path of ['ancestor', 'state-link', 'private-state', '../']) await assert.rejects(files.list(path));
    const listing = await files.list('.');
    assert.ok(listing.includes('ok')); assert.ok(listing.includes('nested/'));
    for (const name of ['.env', '.ssh', 'certificate.pem', 'mcp.json', 'token', 'private-state', 'leaf', 'ancestor', 'state-link', 'hardlink', 'pipe']) {
      assert.ok(!listing.split('\n').some(entry => entry === name || entry === name + '/'), name);
    }
    await assert.rejects(WorkflowBuilderFiles.create(join(f.root, 'alias'), f.state));
    await assert.rejects(WorkflowBuilderFiles.create(join(f.scope, 'ancestor'), f.state));
    await assert.rejects(WorkflowBuilderFiles.create(f.state, f.state));
  } finally { await files?.close(); f.cleanup(); }
});

it('Darwin reader acknowledges checks only for the Scope root', { skip: !darwin, timeout: 10_000 }, async () => {
  const f = fixture();
  const root = await open(f.scope, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
  try {
    mkdirSync(join(f.scope, 'nested'));
    assert.deepEqual(await readerResponse(root, f.scope, { scope: f.scope, path: '.', operation: 'check' }),
      { ok: true, result: { checked: true } });
    for (const path of ['nested', '../state', f.scope, 'nested/..']) {
      assert.deepEqual(await readerResponse(root, f.scope, { scope: f.scope, path, operation: 'check' }), { ok: false });
    }
    assert.deepEqual(await readerResponse(root, f.scope, { scope: f.state, path: '.', operation: 'check' }), { ok: false });
    const file = await open(join(f.scope, 'file'), 'w+');
    try {
      assert.deepEqual(await readerResponse(file, f.scope, { scope: f.scope, path: '.', operation: 'check' }), { ok: false });
    } finally { await file.close(); }
  } finally { await root.close(); f.cleanup(); }
});

it('Darwin validates the check acknowledgement before accepting metadata', { skip: !darwin, timeout: 10_000 }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  try {
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    for (const result of [null, { checked: false }, { content: '' }, { entries: [], truncated: false }]) {
      const rejected = assert.rejects(files.checkScope(), /reference unavailable/);
      const owner = await pausedHelpers(files, 1);
      const helper = [...owner.helpers][0]!;
      helper.child.emit('message', { ok: true, result });
      await rejected; await helper.exited;
      assert.equal(owner.helpers.size, 0);
      assert.ok(owner.root.fd >= 0);
    }
  } finally { await files?.close(); f.cleanup(); }
});

it('Darwin reader refuses a cwd different from its inherited Scope descriptor for read, list and check', { skip: !darwin, timeout: 10_000 }, async () => {
  const f = fixture();
  const root = await open(f.scope, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
  try {
    for (const operation of ['read', 'list', 'check']) {
      assert.deepEqual(await readerResponse(root, f.state, { scope: f.scope, path: '.', operation }), { ok: false });
    }
  } finally { await root.close(); f.cleanup(); }
});

it('Darwin bounds visits including filtered entries and never changes the host cwd', { skip: !darwin }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  const cwd = process.cwd();
  try {
    mkdirSync(join(f.scope, 'many'));
    for (let i = 0; i < 220; i++) writeFileSync(join(f.scope, 'many', `.env.${i}`), 'private');
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    assert.equal(await files.list('many'), '[listing truncated]');
    assert.equal(process.cwd(), cwd);
    for (let i = 0; i < 220; i++) writeFileSync(join(f.scope, 'many', String(i)), '');
    const listing = await files.list('many');
    assert.ok(listing.includes('[listing truncated]'));
    assert.ok(listing.split('\n').length <= 201);
    assert.equal(process.cwd(), cwd);
  } finally { await files?.close(); f.cleanup(); }
});

it('Darwin refuses a redirected Scope, including aliases to the original directory', { skip: !darwin }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  try {
    writeFileSync(join(f.scope, 'ok'), 'original');
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    renameSync(f.scope, f.scope + '-old');
    mkdirSync(f.scope); writeFileSync(join(f.scope, 'ok'), 'redirected');
    await assert.rejects(files.read('ok'));
    await assert.rejects(files.list('.'));
    await assert.rejects(files.checkScope());
    rmSync(f.scope, { recursive: true });
    symlinkSync(f.scope + '-old', f.scope);
    await assert.rejects(files.read('ok'));
    await assert.rejects(files.list('.'));
    await assert.rejects(files.checkScope());
  } finally { await files?.close(); f.cleanup(); }
});

it('Darwin uses fixed application code, bounds active readers, kills/reaps on close and keeps fd ownership', { skip: !darwin }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  const inherited = process.env.NODE_OPTIONS;
  try {
    writeFileSync(join(f.scope, 'ok'), 'reference');
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    // A preload injected through the host environment must not reach the helper.
    process.env.NODE_OPTIONS = '--import=data:text/javascript,process.exit(73)';
    assert.equal(await files.read('ok'), 'reference');
    await files.checkScope();
    const pending = Array.from({ length: 8 }, (_, index) => index % 2 ? files!.read('ok') : files!.checkScope());
    const outcomes = Promise.allSettled(pending);
    await assert.rejects(files.read('ok'), /reference unavailable/);
    await assert.rejects(files.checkScope(), /reference unavailable/);
    // Pause real disposable readers, proving close does not depend on cooperative IPC.
    const owner = await pausedHelpers(files, 8);
    const helpers = [...owner.helpers];
    const start = Date.now();
    const closing = files.close();
    assert.ok(owner.root.fd >= 0); // Defer root descriptor close until operations terminate.
    assert.equal(files.close(), closing);
    await closing;
    assert.ok((await outcomes).every(outcome => outcome.status === 'rejected'));
    await Promise.all(helpers.map(helper => helper.exited));
    assert.equal(owner.helpers.size, 0);
    assert.equal(owner.root.fd, -1);
    assert.ok(Date.now() - start < 5000);
    await assert.rejects(files.read('ok'));
    await assert.rejects(files.list('.'));
    await assert.rejects(files.checkScope());
  } finally {
    if (inherited === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = inherited;
    await files?.close(); f.cleanup();
  }
});

for (const operation of ['read', 'check'] as const) it(`Darwin kills and reaps an unresponsive ${operation} helper at the five-second deadline`, { skip: !darwin, timeout: 10_000 }, async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  try {
    writeFileSync(join(f.scope, 'ok'), 'reference');
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    const start = Date.now();
    const rejected = assert.rejects(operation === 'check' ? files.checkScope() : files.read('ok'), /reference unavailable/);
    const owner = await pausedHelpers(files, 1);
    const helper = [...owner.helpers][0]!;
    await rejected; await helper.exited;
    // Allow scheduler latency, but not another shutdown grace period or hung pipe.
    assert.ok(Date.now() - start < 5500);
    assert.equal(owner.helpers.size, 0);
    assert.ok(owner.root.fd >= 0);
  } finally { await files?.close(); f.cleanup(); }
});

it('Darwin refuses cross-device mounted references and listing entries', { skip: !darwin, timeout: 60_000 }, async t => {
  const f = fixture();
  const mount = join(f.scope, 'mounted');
  const image = join(f.root, 'reference.dmg');
  let attached = false;
  let files: WorkflowBuilderFiles | undefined;
  try {
    mkdirSync(mount);
    try {
      execFileSync('/usr/bin/hdiutil', ['create', '-size', '32m', '-fs', 'HFS+', '-volname', 'FlowReaderTest', image], { stdio: 'pipe', timeout: 20_000 });
      execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], { stdio: 'pipe', timeout: 20_000 });
      attached = true;
    } catch {
      t.skip('Disk image mounting is unavailable in this Darwin test environment'); return;
    }
    writeFileSync(join(mount, 'ok'), 'mounted data');
    files = await WorkflowBuilderFiles.create(f.scope, f.state);
    await assert.rejects(files.read('mounted/ok'));
    await assert.rejects(files.list('mounted'));
    assert.ok(!(await files.list('.')).includes('mounted/'));
  } finally {
    await files?.close();
    if (attached) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe', timeout: 15_000 });
    f.cleanup();
  }
});
