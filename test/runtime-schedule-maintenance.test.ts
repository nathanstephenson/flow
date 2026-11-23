import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { WorkflowScheduleService } from '../src/daemon/workflow-schedules.ts';
import { startRuntime } from '../src/daemon/runtime.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { createSchedule, occurrenceId, occurrenceSettings } from '../src/workflows/schedules.ts';

function fixture(t: TestContext) {
  const oidc = Object.entries(process.env).filter(([key]) => key.startsWith('FLOW_OIDC_'));
  for (const [key] of oidc) delete process.env[key];
  const root = mkdtempSync(join(tmpdir(), 'flow-schedule-maintenance-'));
  const register = SessionHost.prototype.registerBackend;
  t.mock.method(SessionHost.prototype, 'registerBackend', function (this: SessionHost, candidate: { name: string }) {
    if (candidate.name === 'fake') register.call(this, new FakeBackend());
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ filesystemIsolation: 'none' }));
  const logs: string[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => { logs.push(values.map(String).join(' ')); });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  t.after(async () => {
    try { await runtime?.stop(); }
    finally {
      for (const [key, value] of oidc) process.env[key] = value;
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root, logs,
    async start() {
      runtime = await startRuntime({ root, version: '1.0.0', mode: 'background', assets: () => ({}), workflowRuntime: () => '/unused' });
      return runtime;
    },
  };
}

test('the fixture clears inherited OIDC settings and restores them after shutdown', async t => {
  const previous = process.env.FLOW_OIDC_ISSUER;
  process.env.FLOW_OIDC_ISSUER = 'https://synthetic-oidc.invalid';
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(input instanceof Request ? input.url : input).hostname, '127.0.0.1');
    return fetchLocal(input, init);
  });
  try {
    await t.test('startup uses no inherited OIDC configuration', async child => {
      const f = fixture(child);
      assert.equal(Object.keys(process.env).some(key => key.startsWith('FLOW_OIDC_')), false);
      await f.start();
    });
    assert.equal(process.env.FLOW_OIDC_ISSUER, 'https://synthetic-oidc.invalid');
  } finally {
    if (previous === undefined) delete process.env.FLOW_OIDC_ISSUER;
    else process.env.FLOW_OIDC_ISSUER = previous;
  }
});

test('schedule store initialization failure disables scheduling without losing unknown scheduled ownership', { timeout: 5000 }, async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'config.json'), JSON.stringify({ filesystemIsolation: 'none', retention: { settled: '1s' } }));
  mkdirSync(join(f.root, 'workflow-schedules'));
  writeFileSync(join(f.root, 'workflow-schedules', 'definitions'), 'synthetic-private-storage-detail');
  const transcripts = new TranscriptStore(f.root);
  for (const [id, scheduledOccurrenceId] of [['scheduled', 'unknown-occurrence'], ['ordinary', undefined]] as const) {
    transcripts.writeMeta({ id, scope: f.root, backend: 'fake', title: id, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      lifecycle: 'settled', settledAt: new Date(0).toISOString(), ...(scheduledOccurrenceId ? { scheduledOccurrenceId } : {}) });
  }
  const runtime = await f.start();
  const request = (path: string) => fetch(`${runtime.daemon.url}${path}`, { headers: { authorization: `Bearer ${runtime.daemon.token}` } });
  const response = await request('/api/sessions');
  assert.equal(response.status, 200);
  assert.equal((await request('/api/workflow-schedules')).status, 404);
  assert.equal(existsSync(join(f.root, 'sessions', 'scheduled')), true);
  assert.equal(existsSync(join(f.root, 'sessions', 'ordinary')), false);
  assert.ok(f.logs.some(line => line.includes('Workflow Schedule initialization failed')));
  assert.doesNotMatch(f.logs.join('\n'), /synthetic-private-storage-detail|ENOTDIR|flow-schedule-maintenance-/);
});

test('available schedule storage allows ordinary Reap after scheduled history expires', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const transcripts = new TranscriptStore(f.root);
  transcripts.writeMeta({ id: 'expired', scope: f.root, backend: 'fake', title: 'Expired', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    lifecycle: 'settled', settledAt: new Date(0).toISOString(), scheduledOccurrenceId: 'expired-occurrence' });
  await f.start();
  assert.equal(existsSync(join(f.root, 'sessions', 'expired')), false);
});

for (const method of ['start', 'prune'] as const) {
  test(`schedule ${method} failure does not prevent Session Host startup`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    t.mock.method(WorkflowScheduleService.prototype, method, async () => { throw new Error('synthetic-private-provider-detail'); });
    const runtime = await f.start();
    const response = await fetch(`${runtime.daemon.url}/api/sessions`, { headers: { authorization: `Bearer ${runtime.daemon.token}` } });
    assert.equal(response.status, 200);
    assert.ok(f.logs.some(line => line.includes('Workflow Schedule')));
    assert.doesNotMatch(f.logs.join('\n'), /synthetic-private-provider-detail/);
  });
}

test('slow retention cleanup does not delay Session Host startup', { timeout: 5000 }, async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pruning = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(WorkflowScheduleService.prototype, 'prune', async () => { entered(); await gate; return []; });
  const started = f.start();
  await pruning;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([started.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
    assert.equal(ready, true);
  } finally { clearTimeout(timer); release(); await started; }
});

test('a missing occurrence checkpoint does not prevent reconciliation or future-only admission for other Schedules', { timeout: 5000 }, async t => {
  const f = fixture(t), store = new WorkflowScheduleStore(f.root);
  const settings = { name: 'Due', workflowId: 'unused', input: {}, projectId: '/tmp', mcpConnectionIds: [],
    timing: { kind: 'interval' as const, value: 1, unit: 'minutes' as const }, concurrency: 1 };
  const schedule = createSchedule(settings, Date.now() - 120_000, true);
  store.saveSchedule(schedule);
  const interrupted = createSchedule(settings, 0, true), id = occurrenceId(interrupted.id, interrupted.activation, interrupted.nextDue!);
  store.claimOccurrence({ version: 1, id, scheduleId: interrupted.id, activation: interrupted.activation, revision: interrupted.revision,
    scheduledAt: interrupted.nextDue!, createdAt: interrupted.nextDue!, settings: occurrenceSettings(interrupted), status: 'running', executionId: 'missing-checkpoint' });
  await f.start();
  const saved = new WorkflowScheduleStore(f.root);
  assert.equal(saved.getOccurrence(id).status, 'interrupted');
  assert.equal(saved.page({ scheduleId: schedule.id }).occurrences[0]?.status, 'missed');
  assert.ok(saved.getSchedule(schedule.id).nextDue! > Date.now());
});

test('a corrupt occurrence checkpoint does not prevent Session Host startup', { timeout: 5000 }, async t => {
  const f = fixture(t), store = new WorkflowScheduleStore(f.root);
  const schedule = createSchedule({ name: 'Corrupt', workflowId: 'unused', input: {}, projectId: '/tmp', mcpConnectionIds: [],
    timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 1 }, 0, true);
  const id = occurrenceId(schedule.id, schedule.activation, schedule.nextDue!);
  store.claimOccurrence({ version: 1, id, scheduleId: schedule.id, activation: schedule.activation, revision: schedule.revision,
    scheduledAt: schedule.nextDue!, createdAt: schedule.nextDue!, settings: occurrenceSettings(schedule), status: 'running', executionId: 'corrupt' });
  const history = join(new WorkflowStore(f.root).ownerPath(`occurrence-${id}`), 'workflows');
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, 'corrupt.json'), '{corrupt');
  await f.start();
  assert.ok(f.logs.some(log => log.includes('Workflow Execution checkpoint is invalid')));
  rmSync(join(history, 'corrupt.json'));
});

test('an interrupted occurrence with unavailable Sandbox support retains its journal without blocking startup', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const store = new WorkflowScheduleStore(f.root);
  const schedule = createSchedule({ name: 'Interrupted', workflowId: 'unused', input: {}, projectId: '/tmp', mcpConnectionIds: [],
    timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 1 }, 0, true);
  const id = occurrenceId(schedule.id, schedule.activation, schedule.nextDue!);
  store.claimOccurrence({ version: 1, id, scheduleId: schedule.id, activation: schedule.activation, revision: schedule.revision,
    scheduledAt: schedule.nextDue!, createdAt: schedule.nextDue!, settings: occurrenceSettings(schedule), status: 'provisioning' });
  const ownerPath = new WorkflowStore(f.root).ownerPath(`occurrence-${id}`);
  mkdirSync(ownerPath, { recursive: true });
  const journal = join(ownerPath, 'sandbox.json');
  writeFileSync(journal, '{}');
  t.mock.method(SessionHost.prototype, 'sandboxSupport', () => undefined);
  const runtime = await f.start();
  const response = await fetch(`${runtime.daemon.url}/api/sessions`, { headers: { authorization: `Bearer ${runtime.daemon.token}` } });
  assert.equal(response.status, 200);
  assert.equal(new WorkflowScheduleStore(f.root).getOccurrence(id).status, 'interrupted');
  assert.equal(existsSync(journal), true);
});

for (const failing of ['reap', 'prune'] as const) {
  test(`a failed ${failing} cannot reject the maintenance chain or stop later sweeps`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    const interval = globalThis.setInterval;
    let sweep: (() => void) | undefined;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, delay?: number) => {
      if (delay === 60 * 60 * 1000) sweep = callback;
      return interval(callback, delay);
    });
    let reaps = 0, prunes = 0, maintenance = false;
    t.mock.method(SessionHost.prototype, 'reap', async () => {
      if (!maintenance) return [];
      if (++reaps === 1 && failing === 'reap') throw new Error('synthetic-private-reap-detail');
      return [];
    });
    t.mock.method(WorkflowScheduleService.prototype, 'prune', async () => {
      if (++prunes === 2 && failing === 'prune') throw new Error('synthetic-private-prune-detail');
      return [];
    });
    const runtime = await f.start();
    maintenance = true;
    assert.ok(sweep);
    sweep();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reaps, 1);
    assert.equal(prunes, 2);
    sweep();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reaps, 2);
    assert.equal(prunes, 3);
    assert.ok(f.logs.some(line => line.includes('next sweep')));
    assert.doesNotMatch(f.logs.join('\n'), /synthetic-private-(reap|prune)-detail/);
    await runtime.stop();
  });
}
