import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { acquireHost, oidcFingerprint, readHost, type HostIdentity } from '../src/daemon/ownership.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { serve } from '../src/daemon/server.ts';
import { ShellRegistry } from '../src/daemon/shell.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';

it('owns a canonical root exclusively and releases only its instance', () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-owner-'));
  try {
    symlinkSync(root, join(root, 'alias'));
    const owner = acquireHost(join(root, 'alias'));
    assert.equal(owner.root, realpathSync(root));
    assert.throws(() => acquireHost(root), /already owns/);
    const identity = { instanceId: owner.instanceId, pid: process.pid } as HostIdentity;
    owner.publish(identity);
    assert.equal(readHost(root)?.instanceId, owner.instanceId);
    owner.release(); owner.release();
    assert.equal(readHost(root), undefined);
    const next = acquireHost(root);
    owner.release();
    assert.throws(() => acquireHost(root), /already owns/);
    next.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('allows only one simultaneous claimant when reclaiming stale ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-owner-race-'));
  const exited = spawn(process.execPath, ['-e', '']);
  await once(exited, 'exit');
  mkdirSync(join(root, 'host.lock'));
  writeFileSync(join(root, 'host.lock', 'dead.json'), JSON.stringify({ pid: exited.pid }));
  const module = new URL('../src/daemon/ownership.ts', import.meta.url).href;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import { acquireHost } from ${JSON.stringify(module)}; try { acquireHost(${JSON.stringify(root)}); console.log('owner'); setTimeout(() => {}, 2000); } catch { process.exitCode = 2; }`], { stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const results = await Promise.all(children.map(async child => {
      let output = ''; child.stdout.on('data', chunk => { output += chunk; });
      await once(child, 'exit'); return output;
    }));
    assert.equal(results.filter(value => value.includes('owner')).length, 1);
    const reclaimed = acquireHost(root);
    reclaimed.release();
    assert.equal(existsSync(join(root, 'host.lock')), false);
  } finally { children.forEach(child => child.kill()); rmSync(root, { recursive: true, force: true }); }
});

it('requires bearer control, exact instance, and force for active work; closes admission', async () => {
  const host = new SessionHost();
  const backend = new FakeBackend(); host.registerBackend(backend);
  const identity: HostIdentity = { instanceId: 'instance', pid: process.pid, version: 'test', token: 'secret', url: '', mode: 'background', settings: { port: 0, address: '127.0.0.1', cwd: process.cwd(), oidc: oidcFingerprint() } };
  let stopped = 0;
  const running = await serve({ host, token: identity.token, assets: {}, control: { identity, hasActiveWork: () => host.hasActiveWork(), stop: async () => { stopped++; } } });
  const request = (path: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer secret' }) => fetch(`${running.url}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  try {
    assert.equal((await request('/api/sessions', undefined, { cookie: 'flow=secret' })).status, 200);
    assert.equal((await request('/api/host', undefined, { cookie: 'flow=secret' })).status, 401);
    assert.equal((await request('/api/host/stop', { instanceId: 'instance', force: true }, { cookie: 'flow=secret' })).status, 401);
    assert.equal((await request('/api/host')).status, 200);
    const evil = { authorization: 'Bearer secret', origin: 'https://evil.invalid' };
    assert.equal((await request('/api/host', undefined, evil)).status, 403);
    assert.equal((await request('/api/host/stop', { instanceId: 'instance', force: true }, evil)).status, 403);
    assert.equal(stopped, 0);
    assert.equal((await request('/api/host/stop', { instanceId: 'old', force: true })).status, 409);
    const id = await host.create({ scope: process.cwd(), backend: 'fake' });
    await host.send(id, 'hello', 'now');
    assert.equal((await request('/api/host/stop', { instanceId: 'instance' })).status, 409);
    const subagent = backend.latest.beginSubagent('worker');
    const background = backend.latest.backgroundCall();
    backend.latest.completeTurn();
    assert.equal((await request('/api/host/stop', { instanceId: 'instance' })).status, 409);
    subagent.finish();
    assert.equal((await request('/api/host/stop', { instanceId: 'instance' })).status, 409);
    background.settle('complete');
    await host.send(id, 'waiting', 'now');
    backend.latest.askPermission('Bash');
    assert.equal((await request('/api/host/stop', { instanceId: 'instance' })).status, 409);
    assert.equal((await request('/api/host/stop', { instanceId: 'instance', force: true })).status, 202);
    assert.equal((await request('/api/command', { type: 'create', scope: process.cwd(), backend: 'fake' })).status, 503);
    assert.equal((await fetch(`${running.url}/api/workflows/test`, { method: 'PUT', headers: { authorization: 'Bearer secret' }, body: '{}' })).status, 503);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, 1);
  } finally { await host.shutdown(); await running.close(); }
});

it('refuses occupied Workflow test slots and live Shells even when the parent is Idle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-control-work-'));
  const host = new SessionHost();
  const backend = new FakeBackend();
  host.registerBackend(backend);
  const workflows = new WorkflowStore(root);
  const service = new WorkflowExecutionService(host, workflows, new SecretStore(root), new ConfigStore(root), join(root, 'runtime.cjs'));
  let exit: ((event: { exitCode: number }) => void) | undefined;
  const shells = new ShellRegistry({ loadPty: async () => ({ spawn: () => ({ onData() {}, onExit(listener) { exit = listener; }, write() {}, resize() {}, kill() { exit?.({ exitCode: 0 }); } }) }) });
  const identity = { instanceId: 'work', token: 'secret' } as HostIdentity;
  const running = await serve({ host, token: 'secret', assets: {}, shells, workflowExecutions: service, control: { identity, hasActiveWork: () => host.hasActiveWork() || shells.hasLiveShells() || host.list().some(session => service.list(session.id).occupied), stop: async () => {} } });
  const stop = () => fetch(`${running.url}/api/host/stop`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ instanceId: 'work' }) });
  try {
    const sessionId = await host.create({ scope: root, backend: 'fake' });
    const started = await service.start({ sessionId, stepId: 'agent', input: {}, definition: { version: 1, id: 'test', name: 'Test', backend: 'fake', permission: 'ask', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'Wait', outputSchema: { type: 'string' } }], edges: [] } });
    assert.equal(service.active(sessionId), 0);
    assert.equal(service.list(sessionId).occupied, true);
    assert.equal((await stop()).status, 409);
    await service.cancel(sessionId, started.execution.id);
    await new Promise(resolve => setImmediate(resolve));
    backend.latest.completeTurn();
    assert.equal(service.list(sessionId).occupied, false);
    await shells.create({ sessionId, cwd: root });
    assert.equal((await stop()).status, 409);
    await shells.killAll();
    assert.equal(shells.hasLiveShells(), false);
    assert.equal((await stop()).status, 202);
  } finally { await host.shutdown(); await shells.killAll(); await running.close(); rmSync(root, { recursive: true, force: true }); }
});

it('fails a conflicting listen without an unhandled server error', async () => {
  const first = await serve({ host: new SessionHost(), token: 'secret', assets: {} });
  try {
    await assert.rejects(serve({ host: new SessionHost(), token: 'secret', assets: {}, port: Number(new URL(first.url).port) }), { code: 'EADDRINUSE' });
  } finally { await first.close(); }
});


it('rejects a malformed raw request URL without terminating the host', async () => {
  const running = await serve({ host: new SessionHost(), token: 'secret', assets: {} });
  const socket = connect(Number(new URL(running.url).port), '127.0.0.1');
  try {
    let output = '';
    socket.on('data', chunk => { output += chunk; });
    const closed = once(socket, 'close');
    socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await closed;
    assert.match(output, /HTTP\/1.1 400/);
    assert.equal((await fetch(`${running.url}/api/sessions`, { headers: { authorization: 'Bearer secret' } })).status, 200);
  } finally { socket.destroy(); await running.close(); }
});

it('force stop cancels incomplete command bodies and interrupts active work before drain', async () => {
  const host = new SessionHost();
  const backend = new FakeBackend(); host.registerBackend(backend);
  const id = await host.create({ scope: process.cwd(), backend: 'fake' });
  await host.send(id, 'wait', 'now');
  const identity = { instanceId: 'incomplete', token: 'secret' } as HostIdentity;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const stopped = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const running = await serve({ host, token: 'secret', assets: {}, control: { identity, hasActiveWork: () => host.hasActiveWork(), stop: async () => {
    try { await running.stopAdmission(() => host.shutdown(), 500); finish(); }
    catch (error) { fail(error); }
  } } });
  const socket = connect(Number(new URL(running.url).port), '127.0.0.1');
  try {
    await once(socket, 'connect');
    socket.write('POST /api/command HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer secret\r\nContent-Length: 1000\r\n\r\n{');
    await new Promise(resolve => setTimeout(resolve, 20));
    const response = await fetch(`${running.url}/api/host/stop`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ instanceId: identity.instanceId, force: true }) });
    assert.equal(response.status, 202);
    await stopped;
    assert.equal(host.hasActiveWork(), false);
    assert.equal((await fetch(`${running.url}/api/command`, { method: 'POST' })).status, 503);
  } finally { socket.destroy(); await host.shutdown(); await running.close(); }
});

it('retains ownership when admitted mutations cannot drain by the deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-drain-'));
  const owner = acquireHost(root);
  const host = new SessionHost();
  let finish!: () => void;
  let admitted!: () => void;
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  host.execute = async () => { admitted(); await blocked; };
  const running = await serve({ host, token: 'secret', assets: {} });
  const request = fetch(`${running.url}/api/command`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: '{}' }).catch(() => undefined);
  try {
    await entered;
    let interrupted = false;
    await assert.rejects(running.stopAdmission(async () => { interrupted = true; }, 20).then(() => owner.release()), /drain timed out/);
    assert.equal(interrupted, true);
    assert.throws(() => acquireHost(root), /already owns/);
    assert.equal((await fetch(`${running.url}/api/command`, { method: 'POST' })).status, 503);
    finish();
    await running.stopAdmission();
    owner.release();
  } finally { finish(); await request; await running.close(); owner.release(); rmSync(root, { recursive: true, force: true }); }
});

it('awaits owned Shell exits and escalates only Shells that ignore SIGHUP', async () => {
  const signals: string[][] = [];
  const shells = new ShellRegistry({ loadPty: async () => ({ spawn: () => {
    const index = signals.length;
    const received: string[] = []; signals.push(received);
    let exit!: (event: { exitCode: number }) => void;
    return { onData() {}, onExit(listener) { exit = listener; }, write() {}, resize() {}, kill(signal) {
      received.push(signal!);
      if (index === 0 || signal === 'SIGKILL') setImmediate(() => exit({ exitCode: 0 }));
    } };
  } }) });
  await shells.create({ sessionId: 'test', cwd: process.cwd() });
  await shells.create({ sessionId: 'test', cwd: process.cwd() });
  await shells.killAll(20);
  assert.deepEqual(signals, [['SIGHUP'], ['SIGHUP', 'SIGKILL']]);
  assert.equal(shells.hasLiveShells(), false);
  await assert.rejects(shells.create({ sessionId: 'late', cwd: process.cwd() }), /stopping/);
});

it('fails shutdown when an owned Shell exit cannot be confirmed', async () => {
  const shells = new ShellRegistry({ loadPty: async () => ({ spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) }) });
  await shells.create({ sessionId: 'test', cwd: process.cwd() });
  await assert.rejects(shells.killAll(10), /ownership retained/);
  assert.equal(shells.hasLiveShells(), true);
});


for (const operation of ['create', 'revive'] as const) {
  it(`drains a pending ${operation} before the final Backend Session shutdown`, async () => {
    const host = new SessionHost();
    const backend = new FakeBackend(); host.registerBackend(backend);
    let id: string | undefined;
    if (operation === 'revive') {
      id = await host.create({ scope: process.cwd(), backend: 'fake' });
      await host.settle(id);
    }
    let finish!: () => void;
    let entered!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const create = backend.create.bind(backend);
    backend.create = async options => { entered(); await blocked; return create(options); };
    const running = await serve({ host, token: 'secret', assets: {} });
    const command = operation === 'create' ? { type: 'create', scope: process.cwd(), backend: 'fake' } : { type: 'revive', sessionId: id };
    const request = fetch(`${running.url}/api/command`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify(command) }).catch(() => undefined);
    try {
      await admitted;
      let drained = false;
      const stop = running.stopAdmission(() => host.shutdown()).then(async () => { await host.shutdown(); drained = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(drained, false);
      finish();
      await stop;
      assert.equal(backend.latest.disposed, true);
      assert.equal(host.list()[0]?.status, 'dormant');
    } finally { finish(); await request; await host.shutdown(); await running.close(); }
  });
}
