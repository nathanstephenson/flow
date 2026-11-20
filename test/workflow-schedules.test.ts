import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { advancePast, createSchedule, editSchedule, nextOccurrence, occurrenceId, occurrenceSettings, scheduleSettingsValidator, SCHEDULE_RETENTION_MS } from '../src/workflows/schedules.ts';
import { WorkflowScheduleStore, ScheduleRevisionConflict } from '../src/workflows/schedule-store.ts';
import type { WorkflowOccurrence, WorkflowScheduleSettings } from '../src/protocol/workflow-schedules.ts';

const settings: WorkflowScheduleSettings = { name: 'Check', workflowId: 'check', input: {}, projectId: '/tmp', mcpConnectionIds: [], timing: { kind: 'interval', value: 5, unit: 'minutes' }, concurrency: 3 };
const ms = (iso: string) => Date.parse(iso);
test('enable, re-enable and timing edits wait; unrelated edits preserve anchor', () => {
  const initial = createSchedule(settings, 1000);
  assert.equal(initial.nextDue, undefined);
  const enabled = editSchedule(initial, settings, true, 2000);
  assert.equal(enabled.nextDue, 302000);
  const renamed = editSchedule(enabled, { ...settings, name: 'Renamed' }, true, 5000);
  assert.equal(renamed.nextDue, enabled.nextDue);
  assert.equal(renamed.activation, enabled.activation);
  const paused = editSchedule(renamed, settings, false, 6000);
  assert.equal(paused.nextDue, undefined);
  const resumed = editSchedule(paused, settings, true, 7000);
  assert.equal(resumed.nextDue, 307000);
  assert.equal(resumed.activation, enabled.activation + 1);
  const changed = editSchedule(resumed, { ...settings, timing: { kind: 'interval', value: 1, unit: 'hours' } }, true, 8000);
  assert.equal(changed.nextDue, 3608000);
});
test('interval advancement stays anchored and groups arbitrarily long downtime', () => {
  assert.equal(advancePast(settings.timing, 300000, 1_000_000_000_000), 1_000_000_200_000);
  assert.equal(advancePast(settings.timing, 300000, 200000), 300000);
  assert.equal(advancePast(settings.timing, 300000, 300000), 600000);
  assert.throws(() => nextOccurrence(settings.timing, 8_640_000_000_000_000));
});
test('daily UTC time is strictly future and handles leap days', () => {
  const daily = { kind: 'daily' as const, time: '09:00', timezone: 'UTC' };
  assert.equal(nextOccurrence(daily, ms('2024-02-28T09:00:00Z')), ms('2024-02-29T09:00:00Z'));
  assert.equal(nextOccurrence(daily, ms('2024-02-29T09:00:00Z')), ms('2024-03-01T09:00:00Z'));
});
test('daily IANA schedules skip gaps and use only first fold occurrence', () => {
  const daily = { kind: 'daily' as const, time: '02:30', timezone: 'America/New_York' };
  assert.equal(nextOccurrence(daily, ms('2024-03-09T08:00:00Z')), ms('2024-03-11T06:30:00Z'));
  const fold = { ...daily, time: '01:30' };
  assert.equal(nextOccurrence(fold, ms('2024-11-03T04:00:00Z')), ms('2024-11-03T05:30:00Z'));
  assert.equal(nextOccurrence(fold, ms('2024-11-03T05:30:00Z')), ms('2024-11-04T06:30:00Z'));
  assert.equal(nextOccurrence(fold, ms('2024-11-03T06:00:00Z')), ms('2024-11-04T06:30:00Z'));
  assert.equal(nextOccurrence({ ...daily, timezone: 'Pacific/Apia', time: '09:00' }, ms('2011-12-29T20:00:00Z')), ms('2011-12-30T19:00:00Z'));
});
test('strict schedule validation rejects invalid clocks, arithmetic, selection and bounds', () => {
  for (const timing of [ { kind: 'interval', value: 0, unit: 'minutes' }, { kind: 'interval', value: 1.5, unit: 'minutes' }, { kind: 'interval', value: Number.MAX_SAFE_INTEGER, unit: 'days' }, { kind: 'daily', time: '24:00', timezone: 'UTC' }, { kind: 'daily', time: '09:00', timezone: '+03:00' }, { kind: 'daily', time: '09:00', timezone: 'Invalid/Zone' } ]) assert.throws(() => scheduleSettingsValidator.parse({ ...settings, timing }));
  for (const concurrency of [0, 101, 1.5]) assert.throws(() => scheduleSettingsValidator.parse({ ...settings, concurrency }));
  assert.throws(() => scheduleSettingsValidator.parse({ ...settings, mcpConnectionIds: ['one', 'one'] }));
  assert.throws(() => scheduleSettingsValidator.parse({ ...settings, sessionId: 'injected' }));
  const { concurrency: _, ...defaults } = settings;
  assert.equal(scheduleSettingsValidator.parse(defaults).concurrency, 3);
});
function occurrence(schedule = createSchedule(settings, 0, true), status: WorkflowOccurrence['status'] = 'provisioning'): WorkflowOccurrence {
  return { version: 1, id: occurrenceId(schedule.id, schedule.activation, schedule.nextDue!), scheduleId: schedule.id, activation: schedule.activation, revision: schedule.revision, scheduledAt: schedule.nextDue!, createdAt: schedule.nextDue!, settings: occurrenceSettings(schedule), status, ...(['provisioning', 'running', 'recovery-required'].includes(status) ? {} : { finishedAt: schedule.nextDue! }) };
}
test('durable private store validates identity, conflicts, claims and terminal immutability', () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedules-'));
  try {
    const store = new WorkflowScheduleStore(root), schedule = createSchedule(settings, 0, true);
    store.saveSchedule(schedule);
    assert.deepEqual(new WorkflowScheduleStore(root).getSchedule(schedule.id), schedule);
    assert.equal(statSync(join(store.root, 'definitions', schedule.id + '.json')).mode & 0o777, 0o600);
    assert.equal(statSync(store.root).mode & 0o777, 0o700);
    assert.throws(() => store.saveSchedule(schedule), ScheduleRevisionConflict);
    const edited = editSchedule(schedule, { ...settings, name: 'New' }, true, 1);
    store.saveSchedule(edited, schedule.revision);
    assert.throws(() => store.saveSchedule(edited, schedule.revision), ScheduleRevisionConflict);
    assert.throws(() => store.getSchedule('../escape'));
    const item = occurrence(schedule);
    assert.equal(store.claimOccurrence(item), true);
    assert.equal(store.claimOccurrence(item), false);
    const terminal = { ...item, status: 'completed' as const, finishedAt: 400000 };
    store.saveOccurrence(terminal);
    assert.throws(() => store.saveOccurrence({ ...terminal, outcome: 'changed' }));
    assert.throws(() => store.claimOccurrence({ ...item, id: 'forged' }));
    assert.throws(() => store.advanceCursor(schedule.id, schedule.revision, schedule.nextDue!, schedule.nextDue! + 300000), ScheduleRevisionConflict);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('history pagination survives deletion and pruning never removes active work or transcripts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedules-'));
  try {
    const store = new WorkflowScheduleStore(root), schedule = createSchedule(settings, 0, true);
    store.saveSchedule(schedule);
    const terminal = occurrence(schedule, 'completed');
    store.claimOccurrence(terminal);
    const activeSchedule = { ...schedule, nextDue: 600000 };
    const active = occurrence(activeSchedule);
    store.claimOccurrence(active);
    const first = store.page({ limit: 1 });
    assert.equal(first.occurrences[0]!.id, active.id);
    assert.equal(store.page({ limit: 1, before: first.next }).occurrences[0]!.id, terminal.id);
    assert.throws(() => store.page({ limit: 0 }));
    store.deleteSchedule(schedule.id, 1, 1);
    assert.equal(store.listSchedules().length, 0);
    const cleaned: string[] = [];
    assert.deepEqual(await store.prune(terminal.finishedAt! + SCHEDULE_RETENTION_MS - 1, async item => { cleaned.push(item.id); }), []);
    assert.deepEqual(await store.prune(terminal.finishedAt! + SCHEDULE_RETENTION_MS, async item => { cleaned.push(item.id); }), [terminal.id]);
    assert.deepEqual(cleaned, [terminal.id]);
    assert.equal(store.getOccurrence(active.id).status, 'provisioning');
    assert.equal(store.listSchedules(true).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('startup indexes history once; active counts do not read history and pages read only requested payloads', t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedules-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowScheduleStore(root), schedule = createSchedule(settings, 0, true);
  store.saveSchedule(schedule);
  const payload = 'x'.repeat(32_768);
  for (let i = 1; i <= 64; i++) store.claimOccurrence(occurrence({ ...schedule, input: { payload }, nextDue: i * 300_000 }, 'completed'));
  const active = occurrence({ ...schedule, nextDue: 65 * 300_000 }); store.claimOccurrence(active);
  const reads = t.mock.method(fs, 'readFileSync'); syncBuiltinESMExports();
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
  const loaded = new WorkflowScheduleStore(root);
  assert.equal(reads.mock.callCount(), 66);
  assert.ok(serialize(loaded).byteLength < payload.length * 2, 'The history index must not retain completed input payloads');
  reads.mock.resetCalls();
  assert.equal(loaded.activeCount(schedule.id), 1);
  assert.equal(reads.mock.callCount(), 0);
  const first = loaded.page({ scheduleId: schedule.id, limit: 10 });
  assert.equal(first.occurrences[0]!.id, active.id);
  assert.equal(loaded.page({ before: first.next, limit: 10 }).occurrences.length, 10);
  loaded.saveOccurrence({ ...active, status: 'completed', finishedAt: active.createdAt + 1 });
  assert.equal(loaded.activeCount(), 0);
  const next = occurrence({ ...schedule, nextDue: 66 * 300_000 }); loaded.claimOccurrence(next);
  assert.equal(loaded.activeCount(schedule.id), 1);
  assert.equal(loaded.page({ limit: 1 }).occurrences[0]!.id, next.id);
  const copy = loaded.getOccurrence(next.id); copy.settings.name = 'Not saved';
  assert.equal(loaded.getOccurrence(next.id).settings.name, settings.name);
  loaded.advanceCursor(schedule.id, 1, schedule.nextDue!, schedule.nextDue! + 300_000);
  assert.equal(loaded.getSchedule(schedule.id).nextDue, schedule.nextDue! + 300_000);
  assert.equal(reads.mock.callCount(), 19);
  const readsBeforePruning = reads.mock.callCount();
  return loaded.prune(0, async () => { assert.fail('Nothing has expired'); }).then(() => {
    assert.equal(reads.mock.callCount(), readsBeforePruning);
  });
});
test('retention saves the authoritative terminal projection before external cleanup can fail', async t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedules-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowScheduleStore(root), schedule = createSchedule(settings, 0, true);
  const active = occurrence(schedule), terminal = { ...active, status: 'completed' as const, finishedAt: active.createdAt + 1 };
  store.claimOccurrence(active);
  store.setOccurrenceProjection(() => terminal);
  assert.deepEqual(await store.prune(terminal.finishedAt + SCHEDULE_RETENTION_MS, async () => {
    store.setOccurrenceProjection(value => value);
    assert.equal(new WorkflowScheduleStore(root).getOccurrence(active.id).status, 'completed');
    throw new Error('external cleanup failed');
  }), []);
  assert.equal(store.getOccurrence(active.id).status, 'completed');
  assert.equal(store.page().occurrences.length, 1);
});
