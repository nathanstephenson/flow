import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoute, formatRoute } from './route.ts';
import { scheduleState, scheduleTiming, sharedDirectoryWarning } from './workflow-schedules.ts';
import type { WorkflowSchedule } from '../../../src/protocol/workflow-schedules.ts';

test('schedule bookmarks round-trip independently of Agent Session selection and settings', () => {
  for (const route of [
    { sessionId: undefined, schedules: true as const },
    { sessionId: undefined, schedules: true as const, scheduleId: 'saved schedule' },
    { sessionId: undefined, schedules: true as const, occurrenceId: 'occurrence-1' },
    { sessionId: undefined, schedules: true as const, occurrenceId: 'occurrence-1', settings: 'workflows' as const },
  ]) assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(parseRoute('#/schedules/%'), { sessionId: undefined, schedules: true });
  assert.deepEqual(parseRoute('#/schedules/occurrences/%'), { sessionId: undefined, schedules: true });
});
test('schedule presentation states and overlap warnings describe saved policy', () => {
  const schedule: WorkflowSchedule = { version: 1, id: 'one', name: 'One', workflowId: 'check', input: {}, projectId: '/tmp', mcpConnectionIds: [], timing: { kind: 'interval', value: 5, unit: 'minutes' }, concurrency: 3, activation: 0, revision: 1, enabled: false, createdAt: 0, updatedAt: 0 };
  assert.equal(scheduleState(schedule), 'Paused');
  assert.equal(scheduleState({ ...schedule, enabled: true }), 'Enabled');
  assert.equal(scheduleState({ ...schedule, deletedAt: 1 }), 'Deleted');
  assert.equal(scheduleTiming(schedule.timing), 'Every 5 minutes');
  assert.equal(scheduleTiming({ kind: 'daily', time: '09:00', timezone: 'America/New_York' }), 'Daily at 09:00 · America/New_York');
  assert.match(sharedDirectoryWarning(undefined)!, /overlapping runs/);
  assert.equal(sharedDirectoryWarning({ from: 'main' }), undefined);
});
