import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { WorkflowScheduleService } from '../src/daemon/workflow-schedules.ts';
import { startRuntime } from '../src/daemon/runtime.ts';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { createSchedule, occurrenceId, occurrenceSettings } from '../src/workflows/schedules.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedule-maintenance-'));
  const register = SessionHost.prototype.registerBackend;
  t.mock.method(SessionHost.prototype, 'registerBackend', function (this: SessionHost, candidate: { name: string }) {
    if (candidate.name === 'fake') register.call(this, new FakeBackend());
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ filesystemIsolation: 'none' }));
  const logs: string[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => { logs.push(values.map(String).join(' ')); });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  t.after(async () => { await runtime?.stop(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, logs,
    async start() {
      runtime = await startRuntime({ root, version: '1.0.0', mode: 'background', assets: () => ({}), workflowRuntime: () => '/unused' });
      return runtime;
    },
  };
}

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
