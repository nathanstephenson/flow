import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { createSchedule, occurrenceId, occurrenceSettings, SCHEDULE_RETENTION_MS } from '../src/workflows/schedules.ts';
import type { WorkflowOccurrence, WorkflowScheduleSettings } from '../src/protocol/workflow-schedules.ts';

const settings: WorkflowScheduleSettings = { name: 'Check', workflowId: 'check', input: {}, projectId: '/tmp', mcpConnectionIds: [], timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 1 };
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-store-review-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowScheduleStore(root), schedule = createSchedule(settings, 0, true); store.saveSchedule(schedule);
  function claim(at: number) {
    const item: WorkflowOccurrence = { version: 1, id: occurrenceId(schedule.id, 1, at), scheduleId: schedule.id, activation: 1, revision: 1, scheduledAt: at, createdAt: at, finishedAt: at, status: 'completed', settings: occurrenceSettings(schedule) };
    store.claimOccurrence(item); return item;
  }
  return { root, store, schedule, claim };
}
test('retention isolates cleanup failures and retries them on later sweeps', async t => {
  const logs = t.mock.method(console, 'error', () => {});
  const f = fixture(t), older = f.claim(60_000), newer = f.claim(120_000);
  const calls: string[] = [];
  assert.deepEqual(await f.store.prune(120_000 + SCHEDULE_RETENTION_MS, async item => {
    calls.push(item.id); if (item.id === newer.id) throw new Error('secret cleanup detail');
  }), [older.id]);
  assert.deepEqual(calls, [newer.id, older.id]);
  assert.equal(f.store.getOccurrence(newer.id).status, 'completed');
  assert.deepEqual(await f.store.prune(120_000 + SCHEDULE_RETENTION_MS, async () => {}), [newer.id]);
  assert.ok(!JSON.stringify(logs.mock.calls).includes('secret'));
});
test('constructor isolates bad records and filenames, preserves files and unknown ownership', async t => {
  const logs = t.mock.method(console, 'error', () => {});
  const f = fixture(t), valid = f.claim(60_000);
  const files = [
    ['definitions', 'broken.json', '{secret'],
    ['definitions', 'invalid name.json', '{}'],
    ['definitions', 'mismatch.json', JSON.stringify(f.schedule)],
    ['occurrences', 'broken.json', '{secret'],
    ['occurrences', 'invalid name.json', '{}'],
    ['occurrences', 'mismatch.json', JSON.stringify(valid)],
  ];
  for (const [directory, name, content] of files) { mkdirSync(join(f.store.root, directory!), { recursive: true }); writeFileSync(join(f.store.root, directory!, name!), content!); }
  const loaded = new WorkflowScheduleStore(f.root);
  assert.equal(loaded.listSchedules().length, 1); assert.equal(loaded.page().occurrences.length, 1);
  loaded.deleteSchedule(f.schedule.id, 1, 0);
  await loaded.prune(60_000 + SCHEDULE_RETENTION_MS, async () => {});
  assert.ok(existsSync(join(loaded.root, 'definitions', `${f.schedule.id}.json`)), 'Unknown occurrences must preserve possible schedule ownership');
  for (const [directory, name, content] of files) assert.equal(readFileSync(join(loaded.root, directory!, name!), 'utf8'), content);
  assert.equal(logs.mock.callCount(), 6); assert.ok(!JSON.stringify(logs.mock.calls).includes('secret'));
});
test('a malformed occurrence file cannot be overwritten by a fresh admission claim', t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t), item = f.claim(60_000), path = join(f.store.root, 'occurrences', `${item.id}.json`);
  writeFileSync(path, '{secret');
  const loaded = new WorkflowScheduleStore(f.root);
  assert.equal(loaded.claimOccurrence(item), false);
  assert.equal(readFileSync(path, 'utf8'), '{secret');
});
test('history cursor remains usable after its occurrence expires and the store restarts', async t => {
  const f = fixture(t), older = f.claim(60_000), middle = f.claim(120_000), newer = f.claim(180_000);
  const olderPath = join(f.store.root, 'occurrences', `${older.id}.json`);
  writeFileSync(olderPath, JSON.stringify({ ...older, finishedAt: 300_000 }));
  const indexed = new WorkflowScheduleStore(f.root);
  const page = indexed.page({ limit: 2 }); assert.equal(page.occurrences[1]!.id, middle.id);
  await indexed.prune(120_000 + SCHEDULE_RETENTION_MS, async () => {});
  const loaded = new WorkflowScheduleStore(f.root);
  assert.deepEqual(loaded.page({ before: page.next }).occurrences.map(item => item.id), [older.id]);
  assert.equal(loaded.page().occurrences[0]!.id, newer.id);
});
