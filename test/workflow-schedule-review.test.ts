import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowScheduleService, type ScheduleDriver } from '../src/daemon/workflow-schedules.ts';
import type { WorkflowOccurrence, WorkflowScheduleSettings } from '../src/protocol/workflow-schedules.ts';
import { createSchedule, occurrenceId, occurrenceSettings, SCHEDULE_RETENTION_MS } from '../src/workflows/schedules.ts';

const settings: WorkflowScheduleSettings = { name: 'Check', workflowId: 'check', input: {}, projectId: '/tmp', mcpConnectionIds: [], timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 1 };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: import('node:test').TestContext, overrides: Partial<ScheduleDriver> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedule-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowScheduleStore(root);
  let now = 0;
  const launched: string[] = [];
  const service = new WorkflowScheduleService(store, { validate: async () => {}, launch: async item => { launched.push(item.id); }, reconcile: async () => {}, cancel: async () => {}, cleanup: async () => {}, ...overrides }, () => now);
  function claim(at: number, status: WorkflowOccurrence['status'] = 'provisioning') {
    const schedule = createSchedule(settings, at - 60_000, true);
    const item: WorkflowOccurrence = { version: 1, id: occurrenceId(schedule.id, 1, at), scheduleId: schedule.id, activation: 1, revision: 1, scheduledAt: at, createdAt: at, settings: occurrenceSettings(schedule), status,
      ...(['provisioning', 'running', 'recovery-required'].includes(status) ? {} : { finishedAt: at }) };
    store.claimOccurrence(item); return item;
  }
  return { root, store, service, launched, claim, time: (value: number) => { now = value; } };
}

test('startup isolates reconcile and admission failures, arms timers and retries without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = t.mock.method(console, 'error', () => {});
  const reconciled: string[] = [];
  let failedId = '', fail = true;
  const f = fixture(t, { reconcile: async item => {
    reconciled.push(item.id);
    if (item.id === failedId && fail) throw new Error('secret reconcile detail');
    f.store.saveOccurrence({ ...item, status: 'interrupted', finishedAt: 120_000 });
  } });
  failedId = f.claim(60_000).id;
  const healthy = f.claim(61_000);
  const schedule = createSchedule(settings, 0, true); f.store.saveSchedule(schedule);
  const advance = f.store.advanceCursor.bind(f.store);
  let cursorFail = true;
  f.store.advanceCursor = (...args) => { if (cursorFail) throw new Error('secret cursor detail'); advance(...args); };
  f.time(60_000); await f.service.start();
  assert.equal(f.store.getOccurrence(healthy.id).status, 'interrupted');
  assert.equal(f.store.getOccurrence(failedId).status, 'provisioning');
  assert.equal(f.store.page({ scheduleId: schedule.id }).occurrences[0]!.status, 'missed');
  fail = false; cursorFail = false;
  t.mock.timers.tick(30_000); await flush(); await flush();
  assert.equal(f.store.getOccurrence(failedId).status, 'interrupted');
  assert.equal(reconciled.filter(id => id === failedId).length, 2);
  f.time(120_000); t.mock.timers.tick(30_000); await flush();
  assert.equal(f.launched.length, 1);
  assert.ok(!JSON.stringify(logs.mock.calls).includes('secret'));
  await f.service.stopAdmission();
});

test('failed startup claims remain missed when live admission retries within the tolerance', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t), schedule = await f.service.create(settings, true);
  const claim = f.store.claimOccurrence.bind(f.store);
  f.store.claimOccurrence = () => { throw new Error('disk unavailable'); };
  f.time(60_000); await f.service.start(false);
  f.store.claimOccurrence = claim;
  await f.service.tick(); await flush();
  assert.equal(f.launched.length, 0);
  assert.equal(f.store.page({ scheduleId: schedule.id }).occurrences[0]!.status, 'missed');
  f.time(120_000); await f.service.tick(); await flush();
  assert.equal(f.launched.length, 1);
  await f.service.stopAdmission();
});

test('stale pending terminal updates are discarded; failed active writes retry without blocking retention', async t => {
  const logs = t.mock.method(console, 'error', () => {});
  const f = fixture(t); await f.service.start(false);
  const stale = f.claim(60_000), active = f.claim(61_000, 'running'), expired = f.claim(62_000, 'completed');
  const save = f.store.saveOccurrence.bind(f.store);
  f.store.saveOccurrence = () => { throw new Error('secret disk detail'); };
  const record = (item: WorkflowOccurrence, status: 'running' | 'completed') => ({ version: 2 as const, occurrenceId: item.id, id: `exec-${item.id}`, scope: '/tmp', definition: { version: 1 as const, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object' as const, fields: {} }, steps: [], edges: [] }, input: {}, steps: {}, startedAt: item.createdAt, status, ...(status === 'completed' ? { finishedAt: item.createdAt } : {}) });
  assert.throws(() => f.service.result(record(stale, 'completed')));
  assert.throws(() => f.service.result(record(active, 'running')));
  f.store.saveOccurrence = save;
  save({ ...stale, status: 'cancelled', finishedAt: 63_000 });
  let activeWrites = 0, terminalWrites = 0;
  f.store.saveOccurrence = item => {
    if (item.id === stale.id) { terminalWrites++; throw new Error('Terminal occurrence is immutable'); }
    if (item.id === active.id) { activeWrites++; throw new Error('secret disk detail'); }
    save(item);
  };
  f.time(62_000 + SCHEDULE_RETENTION_MS);
  assert.deepEqual(await f.service.prune(), [expired.id]);
  assert.equal(terminalWrites, 0);
  assert.equal(f.store.getOccurrence(stale.id).status, 'cancelled');
  await assert.rejects(f.service.tick());
  assert.ok(activeWrites >= 2);
  f.store.saveOccurrence = save; await f.service.tick();
  assert.equal(new WorkflowScheduleStore(f.root).getOccurrence(active.id).executionId, `exec-${active.id}`);
  assert.ok(!JSON.stringify(logs.mock.calls).includes('secret'));
  await f.service.stopAdmission();
});

test('retention can finish a pending terminal write without leaving a stale retry', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t); await f.service.start(false);
  const item = f.claim(60_000), save = f.store.saveOccurrence.bind(f.store);
  let failures = 2;
  f.store.saveOccurrence = value => { if (failures-- > 0) throw new Error('disk unavailable'); save(value); };
  assert.throws(() => f.service.result({ version: 2, occurrenceId: item.id, id: 'finished', scope: '/tmp', definition: { version: 1, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] }, input: {}, steps: {}, startedAt: 60_000, finishedAt: 60_001, status: 'completed' }));
  f.time(60_001 + SCHEDULE_RETENTION_MS);
  assert.deepEqual(await f.service.prune(), [item.id]);
  await f.service.tick(); await f.service.tick();
  await f.service.stopAdmission();
});

test('unstarted cleanup does not block startup, mutations, admission or unrelated retention', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const f = fixture(t, { cleanupUnstarted: async () => { entered.resolve(); await release.promise; } });
  const old = f.claim(60_000, 'interrupted'), expired = f.claim(61_000, 'completed');
  f.time(61_000 + SCHEDULE_RETENTION_MS);
  await f.service.start(false); await entered.promise;
  const schedule = await f.service.create(settings, true);
  await f.service.pause(schedule.id, 1);
  await f.service.create(settings, true);
  f.time(121_000 + SCHEDULE_RETENTION_MS); await f.service.tick(); await flush();
  assert.equal(f.launched.length, 1);
  const pruning = f.service.prune();
  await flush();
  assert.throws(() => f.store.getOccurrence(expired.id));
  assert.equal(f.store.getOccurrence(old.id).status, 'interrupted');
  assert.deepEqual(await pruning, [expired.id]);
  release.resolve(); await flush();
  assert.deepEqual(await f.service.prune(), [old.id]);
  await f.service.stopAdmission();
});

test('concurrent tick, retry, retry and cancel serialize occurrence controls, not admission', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const events: string[] = [];
  let active = 0, peak = 0;
  const f = fixture(t, { reconcile: async item => {
    active++; peak = Math.max(peak, active); events.push('retry'); entered.resolve(); await release.promise;
    f.store.saveOccurrence({ ...f.store.getOccurrence(item.id), association: 'attached' }); active--;
  }, cancel: async item => {
    active++; peak = Math.max(peak, active); events.push('cancel');
    f.store.saveOccurrence({ ...f.store.getOccurrence(item.id), status: 'cancelled', finishedAt: 120_000 }); active--;
  } });
  await f.service.start(false);
  const item = f.claim(60_000, 'recovery-required'); f.store.saveOccurrence({ ...item, association: 'failed' });
  await f.service.create(settings, true);
  const save = f.store.saveOccurrence.bind(f.store);
  f.store.saveOccurrence = () => { throw new Error('disk unavailable'); };
  assert.throws(() => f.service.result({ version: 2, occurrenceId: item.id, id: 'recovering', scope: '/tmp', definition: { version: 1, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] }, input: {}, steps: {}, startedAt: 60_000, status: 'recovery-required' }));
  let writesDuringControl = 0;
  f.store.saveOccurrence = value => { if (active) writesDuringControl++; save(value); };
  const first = f.service.retryAttachment(item.id); await entered.promise;
  const second = f.service.retryAttachment(item.id);
  const cancelled = f.service.cancel(item.id);
  const results = Promise.allSettled([first, second, cancelled]);
  f.time(60_000); await Promise.all([f.service.tick(), f.service.tick()]); await flush();
  assert.equal(f.launched.length, 1);
  assert.equal(writesDuringControl, 0);
  await f.service.create(settings, false);
  release.resolve();
  assert.deepEqual((await results).map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(events, ['retry', 'cancel']); assert.equal(peak, 1);
  assert.equal(f.store.getOccurrence(item.id).status, 'cancelled');
  await f.service.stopAdmission();
});

test('retention does not change occurrence state while attachment reconciliation owns it', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  let completed = false, controlling = false, writesDuringControl = 0;
  const f = fixture(t, { current: item => completed ? { version: 2, occurrenceId: item.id, id: 'finished', scope: '/tmp', definition: { version: 1, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] }, input: {}, steps: {}, startedAt: 60_000, finishedAt: 60_001, status: 'completed' } : undefined,
    reconcile: async item => {
      controlling = true; entered.resolve(); await release.promise; controlling = false;
      f.store.saveOccurrence({ ...f.store.getStoredOccurrence(item.id), status: 'completed', finishedAt: 60_001 });
    } });
  await f.service.start(false);
  const item = f.claim(60_000, 'recovery-required'); f.store.saveOccurrence({ ...item, association: 'failed' });
  const save = f.store.saveOccurrence.bind(f.store);
  f.store.saveOccurrence = value => { if (controlling) writesDuringControl++; save(value); };
  const retry = f.service.retryAttachment(item.id); await entered.promise;
  completed = true; f.time(60_001 + SCHEDULE_RETENTION_MS);
  const pruning = f.service.prune(); await flush();
  assert.equal(writesDuringControl, 0);
  assert.deepEqual(await pruning, []);
  release.resolve(); await retry;
  assert.deepEqual(await f.service.prune(), [item.id]);
  await f.service.stopAdmission();
});

test('shutdown waits for admitted occurrence cleanup to finish', { timeout: 2000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { cleanupUnstarted: async () => { entered.resolve(); await release.promise; } });
  f.claim(60_000, 'interrupted');
  await f.service.start(false); await entered.promise;
  let stopped = false;
  const stopping = f.service.stopAdmission().then(() => { stopped = true; });
  try { await flush(); assert.equal(stopped, false); }
  finally { release.resolve(); await stopping; }
  assert.equal(stopped, true);
});

test('terminal pre-execution cleanup runs after provisioning stops and retries across restart without history scans', { timeout: 2000 }, async t => {
  const entered = deferred(), aborted = deferred();
  let provisioning = false, attempts = 0;
  const logs = t.mock.method(console, 'error', () => {});
  const cleanupUnstarted = async (_item: WorkflowOccurrence) => {
    assert.equal(provisioning, false); attempts++;
    if (attempts === 1) throw new Error('secret cleanup detail');
  };
  const f = fixture(t, { launch: async (_item, signal) => {
    provisioning = true; entered.resolve();
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    provisioning = false; aborted.resolve(); signal!.throwIfAborted();
  }, cleanupUnstarted });
  await f.service.start(false); await f.service.create(settings, true);
  f.time(60_000); await f.service.tick(); await entered.promise;
  const id = f.store.page().occurrences[0]!.id;
  await f.service.cancel(id); await aborted.promise; await flush();
  assert.equal(attempts, 1); assert.equal(f.store.getOccurrence(id).status, 'cancelled');
  await f.service.stopAdmission();
  const store = new WorkflowScheduleStore(f.root);
  const service = new WorkflowScheduleService(store, { validate: async () => {}, launch: async () => assert.fail('No replay'), reconcile: async () => {}, cancel: async () => {}, cleanup: async () => {}, cleanupUnstarted }, () => 60_000);
  await service.start(false); await flush(); assert.equal(attempts, 2);
  await service.tick(); await service.prune(); assert.equal(attempts, 2);
  assert.equal(store.getOccurrence(id).status, 'cancelled');
  assert.ok(!JSON.stringify(logs.mock.calls).includes('secret'));
  await service.stopAdmission();
});
