import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowScheduleService, ScheduledExecutionStarted, type ScheduleDriver } from '../src/daemon/workflow-schedules.ts';
import type { WorkflowOccurrence, WorkflowScheduleSettings } from '../src/protocol/workflow-schedules.ts';
import type { WorkflowExecution } from '../src/protocol/workflows.ts';
import { SCHEDULE_RETENTION_MS } from '../src/workflows/schedules.ts';

const settings: WorkflowScheduleSettings = { name: 'Scheduled', workflowId: 'check', input: {}, projectId: '/tmp', mcpConnectionIds: [], timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 1 };
function fixture(t: import('node:test').TestContext, overrides: Partial<ScheduleDriver> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-admission-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowScheduleStore(root), launches: WorkflowOccurrence[] = [];
  let now = 0;
  const service = new WorkflowScheduleService(store, { validate: async () => {}, launch: async occurrence => { launches.push(occurrence); }, reconcile: async occurrence => { store.saveOccurrence({ ...occurrence, status: 'interrupted', finishedAt: now }); }, cancel: async () => {}, cleanup: async () => {}, ...overrides }, () => now);
  return { store, service, launches, time: (value: number) => { now = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('no immediate dispatch, durable claims, anchored overlap skips and no replay after restart', async t => {
  const f = fixture(t); await f.service.start(false);
  const schedule = await f.service.create(settings, true);
  await f.service.tick(); assert.equal(f.launches.length, 0);
  f.time(60_000); await Promise.all([f.service.tick(), f.service.tick()]); await flush();
  assert.equal(f.launches.length, 1); assert.equal(f.store.getSchedule(schedule.id).nextDue, 120_000);
  f.time(120_000); await f.service.tick(); await flush();
  assert.deepEqual(f.store.listOccurrences().map(item => item.status), ['capacity-skipped', 'provisioning']);
  await f.service.stopAdmission();
  f.time(1_000_000_000_000); await f.service.start(false); await flush();
  assert.equal(f.launches.length, 1); assert.equal(f.store.listOccurrences().length, 3);
  assert.equal(f.store.listOccurrences()[0]!.status, 'missed');
  assert.ok(f.store.getSchedule(schedule.id).nextDue! > 1_000_000_000_000);
});
test('live tolerance, backward clock, long downtime and launch failure keep future admission enabled', async t => {
  const f = fixture(t, { launch: async () => { throw new Error('secret diagnostic'); } }); await f.service.start(false);
  const schedule = await f.service.create(settings, true);
  f.time(90_000); await f.service.tick(); await flush();
  assert.equal(f.store.listOccurrences()[0]!.status, 'launch-failed');
  assert.ok(!JSON.stringify(f.store.listOccurrences()).includes('secret diagnostic'));
  f.time(10); await f.service.tick(); assert.equal(f.store.listOccurrences().length, 1);
  f.time(150_001); await f.service.tick(); assert.equal(f.store.listOccurrences()[0]!.status, 'missed');
  assert.equal(f.store.getSchedule(schedule.id).enabled, true);
});
test('slow provisioning reserves capacity; pause/delete preserve claims and history', async t => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(t, { launch: () => pending }); await f.service.start(false);
  const schedule = await f.service.create(settings, true);
  f.time(60_000); await f.service.tick(); await flush();
  f.time(120_000); await f.service.tick(); assert.equal(f.store.listOccurrences()[0]!.status, 'capacity-skipped');
  const updated = await f.service.update(schedule.id, 1, settings, false);
  await f.service.delete(schedule.id, updated.revision);
  assert.equal(f.store.listOccurrences().length, 2); assert.equal(f.store.listSchedules().length, 0);
  finish(); await f.service.stopAdmission();
});
test('claim persistence failure prevents any launch; cursor failure never replays the claimed occurrence', async t => {
  const f = fixture(t); await f.service.start(false); await f.service.create(settings, true); f.time(60_000);
  const claim = f.store.claimOccurrence.bind(f.store);
  f.store.claimOccurrence = () => { throw new Error('disk full'); };
  await assert.rejects(f.service.tick()); assert.equal(f.launches.length, 0);
  f.store.claimOccurrence = claim;
  const cursor = f.store.advanceCursor.bind(f.store);
  f.store.advanceCursor = () => { throw new Error('disk full'); };
  await assert.rejects(f.service.tick()); assert.equal(f.launches.length, 0);
  assert.equal(f.store.listOccurrences()[0]!.status, 'interrupted');
  assert.equal(f.service.hasActiveWork(), false);
  f.store.advanceCursor = cursor;
  await f.service.tick(); await flush(); assert.equal(f.launches.length, 0);
  f.time(120_000); await f.service.tick(); await flush(); assert.equal(f.launches.length, 1);
});

test('post-checkpoint bookkeeping failure retains identity and reserves capacity rather than launch-failed', async t => {
  const f = fixture(t, { launch: async () => { throw new ScheduledExecutionStarted('retained-execution', { cause: new Error('private disk detail') }); } });
  await f.service.start(false); await f.service.create(settings, true);
  f.time(60_000); await f.service.tick(); await flush();
  const saved = f.store.listOccurrences()[0]!;
  assert.equal(saved.status, 'recovery-required'); assert.equal(saved.executionId, 'retained-execution');
  assert.equal(saved.finishedAt, undefined); assert.equal(f.service.hasActiveWork(), true);
  assert.ok(!JSON.stringify(saved).includes('private disk detail'));
  f.time(120_000); await f.service.tick(); await flush();
  assert.equal(f.store.listOccurrences()[0]!.status, 'capacity-skipped');
});

function execution(occurrence: WorkflowOccurrence): WorkflowExecution {
  return { version: 2, occurrenceId: occurrence.id, id: `execution-${occurrence.id}`, scope: occurrence.settings.projectId,
    definition: { version: 1, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] },
    input: {}, steps: {}, startedAt: occurrence.createdAt, finishedAt: occurrence.createdAt + 1000, status: 'completed' };
}
test('a durable completion releases capacity and expires despite a failed occurrence status write, without repeating reconciliation', async t => {
  let checkpoint: WorkflowExecution | undefined, reconciles = 0;
  const f = fixture(t, { current: occurrence => checkpoint?.occurrenceId === occurrence.id ? checkpoint : undefined, reconcile: async () => { reconciles++; } });
  await f.service.start(false); await f.service.create(settings, true);
  f.time(60_000); await f.service.tick(); await flush();
  checkpoint = execution(f.launches[0]!);
  const save = f.store.saveOccurrence.bind(f.store);
  let failures = 1;
  f.store.saveOccurrence = value => { if (failures-- > 0) throw new Error('disk full'); save(value); };
  assert.throws(() => f.service.result(checkpoint!));
  assert.equal(f.service.hasActiveWork(), false);
  assert.equal(f.store.page().occurrences[0]!.status, 'completed');
  f.time(120_000); await f.service.tick(); await flush();
  assert.equal(f.launches.length, 2);
  assert.equal(f.store.listOccurrences()[1]!.status, 'completed');
  assert.equal(reconciles, 0);
  f.time(checkpoint.finishedAt! + SCHEDULE_RETENTION_MS);
  assert.deepEqual(await f.service.prune(), [checkpoint.occurrenceId]);
  assert.throws(() => f.store.getOccurrence(checkpoint!.occurrenceId!));
  await f.service.stopAdmission();
});
test('a failed cursor and failed interruption write are repaired without launching or retaining capacity', async t => {
  const f = fixture(t); await f.service.start(false); await f.service.create(settings, true);
  const cursor = f.store.advanceCursor.bind(f.store), save = f.store.saveOccurrence.bind(f.store);
  let cursorFailures = 1, statusFailures = 1;
  f.store.advanceCursor = (...args) => { if (cursorFailures-- > 0) throw new Error('disk full'); cursor(...args); };
  f.store.saveOccurrence = value => { if (statusFailures-- > 0) throw new Error('disk full'); save(value); };
  f.time(60_000); await assert.rejects(f.service.tick());
  assert.equal(f.store.page().occurrences[0]!.status, 'interrupted');
  assert.equal(f.service.hasActiveWork(), false);
  assert.equal(new WorkflowScheduleStore(join(f.store.root, '..')).page().occurrences[0]!.status, 'provisioning');
  await f.service.tick(); await flush();
  assert.equal(f.store.page().occurrences[0]!.status, 'interrupted');
  assert.equal(new WorkflowScheduleStore(join(f.store.root, '..')).page().occurrences[0]!.status, 'interrupted');
  assert.equal(f.service.hasActiveWork(), false); assert.equal(f.launches.length, 0);
  f.time(120_000); await f.service.tick(); await flush();
  assert.equal(f.launches.length, 1); await f.service.stopAdmission();
});
test('timer admission errors are visible, do not block other schedules and retry without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warning = t.mock.method(console, 'error', () => {});
  const f = fixture(t); await f.service.start();
  const failed = await f.service.create(settings, true);
  await f.service.create({ ...settings, name: 'Healthy' }, true);
  const advance = f.store.advanceCursor.bind(f.store);
  let failures = 1;
  f.store.advanceCursor = (...args) => { if (args[0] === failed.id && failures-- > 0) throw new Error('disk full'); advance(...args); };
  f.time(60_000); t.mock.timers.tick(30_000); await flush();
  assert.equal(warning.mock.calls.filter(call => call.arguments[0] === 'Workflow Schedule admission failed. The Session Host will retry.').length, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.store.page({ scheduleId: failed.id }).occurrences[0]!.status, 'interrupted');
  t.mock.timers.tick(1000); await flush(); assert.equal(f.launches.length, 1);
  f.time(120_000); t.mock.timers.tick(30_000); await flush();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1]!.scheduleId, failed.id);
  await f.service.stopAdmission();
});
test('external retention cleanup does not block mutations or due admission; failed cleanup retains history', { timeout: 2000 }, async t => {
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let fail = true;
  const f = fixture(t, { cleanup: async () => { entered(); await pending; if (fail) throw new Error('cleanup failed'); } });
  await f.service.start(false); const schedule = await f.service.create(settings, true);
  f.time(60_000); await f.service.tick(); await flush();
  const old = f.store.page().occurrences[0]!;
  f.store.saveOccurrence({ ...old, status: 'completed', finishedAt: 61_000 });
  f.time(61_000 + SCHEDULE_RETENTION_MS);
  const pruning = f.service.prune();
  t.after(release);
  await started;
  await f.service.pause(schedule.id, schedule.revision);
  await f.service.create({ ...settings, name: 'New' }, true);
  f.time(121_000 + SCHEDULE_RETENTION_MS); await f.service.tick(); await flush();
  assert.equal(f.launches.length, 2);
  release(); assert.deepEqual(await pruning, []);
  assert.equal(f.store.getOccurrence(old.id).status, 'completed');
  fail = false; assert.deepEqual(await f.service.prune(), [old.id]);
  await f.service.stopAdmission();
});
test('failed launch-status persistence is visible immediately and retried without reserving capacity', async t => {
  const f = fixture(t, { launch: async () => { throw new Error('preflight failed'); } });
  await f.service.start(false); await f.service.create(settings, true);
  const save = f.store.saveOccurrence.bind(f.store);
  let failures = 1;
  f.store.saveOccurrence = value => { if (failures-- > 0) throw new Error('disk full'); save(value); };
  const warning = t.mock.method(console, 'error', () => {});
  f.time(60_000); await f.service.tick(); await flush();
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(f.store.page().occurrences[0]!.status, 'launch-failed');
  assert.equal(f.service.hasActiveWork(), false);
  assert.equal(new WorkflowScheduleStore(join(f.store.root, '..')).page().occurrences[0]!.status, 'provisioning');
  await f.service.tick();
  assert.equal(new WorkflowScheduleStore(join(f.store.root, '..')).page().occurrences[0]!.status, 'launch-failed');
  await f.service.stopAdmission();
});
for (const operation of ['cancel', 'shutdown'] as const) test(`${operation} signals provisioning before waiting and prevents execution`, { timeout: 2000 }, async t => {
  let started!: () => void, aborted = false, effects = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(t, { launch: async (_occurrence, signal) => {
    assert.ok(signal); started();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    });
    signal.throwIfAborted(); effects++;
  } });
  await f.service.start(false); await f.service.create(settings, true);
  f.time(60_000); await f.service.tick(); await entered;
  const id = f.store.page().occurrences[0]!.id;
  if (operation === 'cancel') await f.service.cancel(id); else await f.service.stopAdmission();
  assert.equal(aborted, true); assert.equal(effects, 0);
  assert.equal(f.store.getOccurrence(id).status, operation === 'cancel' ? 'cancelled' : 'interrupted');
  assert.equal(f.service.hasActiveWork(), false);
  await f.service.stopAdmission();
});
