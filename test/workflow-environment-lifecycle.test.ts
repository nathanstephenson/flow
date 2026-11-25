import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { SessionHost } from '../src/daemon/host.ts';
import { WorkflowEnvironment } from '../src/daemon/workflow-environment.ts';
import { createSandbox, sandboxMounts } from '../src/isolation/sandbox.ts';
import { killWorkerTree, type launchWorker } from '../src/backend/worker/launcher.ts';
import { fakeProvider } from './backend/sandbox-fixture.ts';

before(() => {
  if (!existsSync(join(process.cwd(), 'build/backend-worker.mjs'))) execFileSync(process.execPath, ['scripts/build-worker.mjs']);
});

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(); }
  assert.fail('Timed out');
}
const connection = { id: 'local', name: 'Local', enabledByDefault: true, transport: 'stdio' as const, command: process.execPath, args: ['--experimental-strip-types', join(process.cwd(), 'test/fixtures/mcp-server.ts')] };
function fixture(t: import('node:test').TestContext, connections: string[] = [], createScript?: string) {
  let cleanup = async () => {};
  t.after(() => cleanup());
  const f = fakeProvider(t, createScript);
  const host = new SessionHost({ filesystemIsolationMode: () => 'sandbox', sandboxSupport: () => f.support, mcpConnections: () => [connection] });
  const environment = new WorkflowEnvironment(host, 'occurrence-test', f.scope, connections, 'sandbox', f.state);
  cleanup = () => environment.close();
  return { ...f, environment, host };
}

test('a read-only Scope is a read-only Sandbox mount and the state folder is the workspace', async t => {
  let environment: WorkflowEnvironment | undefined;
  t.after(() => environment?.close());
  const f = fakeProvider(t);
  const host = new SessionHost({ filesystemIsolationMode: () => 'sandbox', sandboxSupport: () => f.support, mcpConnections: () => [connection] });
  environment = new WorkflowEnvironment(host, 'occurrence-test', f.scope, [], 'sandbox', f.state, [], true);
  await environment.prepare();
  const spec = f.spec();
  assert.equal(spec.workspace, f.state);
  assert.deepEqual(spec.additionalWorkspaces.filter((mount: { path: string }) => mount.path === f.scope), [{ path: f.scope, readOnly: true }]);
});

test('Sandbox removal failure retains its journal and close retries after holds drain', async t => {
  const f = fakeProvider(t);
  const path = join(f.state, 'sandbox.json');
  const sandbox = await createSandbox(f.support.provider, { name: 'flow-test', workspace: f.scope, mounts: sandboxMounts([f.scope], []), env: {} }, path);
  const firstHold = sandbox.hold(); firstHold();
  const release = sandbox.hold();
  const remove = f.support.provider.remove;
  f.support.provider.remove = ['/bin/false', '{name}'];
  const closing = sandbox.close();
  let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(settled, false);
  release();
  await assert.rejects(closing, /Sandbox provider/);
  assert.equal(existsSync(path), true);
  f.support.provider.remove = remove;
  await sandbox.close();
  assert.equal(existsSync(path), false);
});

test('environment removal failure retains the journal and retries cleanup on close', async t => {
  const f = fixture(t);
  await f.environment.prepare();
  const remove = f.support.provider.remove;
  f.support.provider.remove = ['/bin/false', '{name}'];
  await assert.rejects(f.environment.close(), AggregateError);
  assert.equal(existsSync(join(f.state, 'sandbox.json')), true);
  f.support.provider.remove = remove;
  await f.environment.close();
  assert.equal(existsSync(join(f.state, 'sandbox.json')), false);
  await assert.rejects(f.environment.prepare(), /stopping/);
});

test('client disposal failure does not skip other clients, the worker or VM removal', async t => {
  const f = fixture(t, ['local']);
  const first = await f.environment.client('local');
  const second = await f.environment.client('local');
  let retry = false, otherDisposed = false;
  t.mock.method(first, 'dispose', async () => { if (!retry) throw new Error('client disposal failed'); });
  t.mock.method(second, 'dispose', async () => { otherDisposed = true; });
  const worker = (f.environment as unknown as { worker: ReturnType<typeof launchWorker> }).worker;
  await assert.rejects(f.environment.close(), AggregateError);
  assert.equal(otherDisposed, true);
  await worker.exited;
  assert.equal(existsSync(join(f.state, 'sandbox.json')), false);
  retry = true;
  await f.environment.close();
});

test('explicit recovery replaces a dead MCP worker, not its Sandbox or parallel code', { timeout: 30_000 }, async t => {
  const f = fixture(t, ['local']);
  const client = await f.environment.client('local'); await client.open();
  const vm = await f.environment.vm();
  const marker = join(f.scope, 'parallel-completed');
  const launch = vm.command(f.scope, ['/bin/sh', '-c', `read ready; touch '${marker}'`], {});
  let child!: ReturnType<typeof execFile>;
  const parallel = new Promise<void>((resolve, reject) => { child = execFile(launch.command, launch.args, error => error ? reject(error) : resolve()); });
  try {
    await until(() => f.calls().filter(call => call.startsWith('exec ')).length === 2);
    const worker = (f.environment as unknown as { worker: ReturnType<typeof launchWorker> }).worker;
    await killWorkerTree(worker.child); await worker.exited;
    await assert.rejects(client.open(), /worker/i);
    await assert.rejects(f.environment.client('local'), /worker/i);
    await f.environment.prepare();
    assert.equal(await f.environment.vm(), vm);
    assert.equal(f.calls().filter(call => call === 'create').length, 1);
    assert.equal(f.calls().filter(call => call.startsWith('exec ')).length, 2);
    await f.environment.recover();
    const replacement = await f.environment.client('local'); await replacement.open();
    const echo = replacement.tools().find(tool => tool.definition.name === 'echo')!;
    assert.ok(JSON.stringify(await echo.call({ text: 'recovered' })).includes('recovered'));
    assert.equal(existsSync(marker), false);
  } finally { child.stdin?.end('continue\n'); await parallel; }
  assert.equal(existsSync(marker), true);
  assert.equal(await f.environment.vm(), vm);
  assert.equal(f.calls().filter(call => call === 'create').length, 1);
  assert.equal(f.calls().filter(call => call.startsWith('remove ')).length, 0);
  await assert.rejects(client.open(), /worker/i);
});

test('cancelled provisioning aborts Sandbox create and retains failed removal for retry', async t => {
  const f = fixture(t, [], 'cp "$1" "$LOG/spec.json"; echo create >> "$LOG/calls"; exec sleep 30');
  const remove = f.support.provider.remove;
  f.support.provider.remove = ['/bin/false', '{name}'];
  const controller = new AbortController();
  const opening = f.environment.prepare(controller.signal);
  const rejected = assert.rejects(opening, /abort|cancel/i);
  await until(() => { try { return f.calls().includes('create'); } catch { return false; } });
  controller.abort();
  await rejected;
  await assert.rejects(f.environment.close(), AggregateError);
  assert.equal(existsSync(join(f.state, 'sandbox.json')), true);
  f.support.provider.remove = remove;
  await f.environment.close();
  assert.equal(existsSync(join(f.state, 'sandbox.json')), false);
  assert.equal(f.calls().some(call => call.startsWith('exec ')), false);
});

test('cancelled MCP initialization stops the worker and cannot provide executable clients', { timeout: 15_000 }, async t => {
  const f = fixture(t, ['local']);
  const stalled = join(f.state, 'stalled-worker.sh');
  writeFileSync(stalled, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  f.support.provider.exec = [stalled, '{name}', '{cwd}'];
  const controller = new AbortController();
  const opening = f.environment.prepare(controller.signal);
  const rejected = assert.rejects(opening, /cancel|abort/i);
  const internal = f.environment as unknown as { worker?: ReturnType<typeof launchWorker> };
  await until(() => !!internal.worker);
  controller.abort();
  await rejected;
  await internal.worker!.exited;
  await assert.rejects(f.environment.client('local'), /cancel|abort/i);
  await f.environment.close();
  assert.equal(existsSync(join(f.state, 'sandbox.json')), false);
});

test('an already cancelled preparation creates no Sandbox journal', async t => {
  const f = fixture(t);
  await assert.rejects(f.environment.prepare(AbortSignal.abort()), /abort/i);
  assert.equal(existsSync(join(f.state, 'sandbox.json')), false);
});
