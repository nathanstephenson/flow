import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowScheduleService } from '../src/daemon/workflow-schedules.ts';
import { ScheduleValidationError } from '../src/workflows/schedule-errors.ts';
import { resolveWorkflowCalls } from '../src/workflows/calls.ts';
import { WorkflowValidationError } from '../src/workflows/errors.ts';
import { WorkflowConflict } from '../src/daemon/workflow-execution-values.ts';
import { occurrenceId, occurrenceSettings } from '../src/workflows/schedules.ts';
import { serve } from '../src/daemon/server.ts';
import type { WorkflowSchedule, WorkflowOccurrencePage, WorkflowScheduleSettings } from '../src/protocol/workflow-schedules.ts';

const settings: WorkflowScheduleSettings = { name: 'Check', workflowId: 'check', input: {}, projectId: '/tmp', mcpConnectionIds: [], timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 3 };
test('schedule HTTP routes preserve auth/origin gates, strict validation, revision conflicts and deleted history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedule-api-'));
  const host = new SessionHost({ store: new TranscriptStore(root) });
  const executions = new WorkflowExecutionService(host, new WorkflowStore(root), new SecretStore(root), new ConfigStore(root), '/unused');
  const store = new WorkflowScheduleStore(root);
  let dependencyError: Error | undefined;
  const schedules = new WorkflowScheduleService(store, { validate: async () => { if (dependencyError) throw dependencyError; }, launch: async () => {}, reconcile: async () => {}, cancel: async () => {}, cleanup: async () => {} }, () => 1000);
  const server = await serve({ host, token: 'test', assets: {}, workflowExecutions: executions, workflowSchedules: schedules });
  t.after(async () => { await server.close(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET', body?: unknown, headers = { authorization: 'Bearer test' }) => fetch(server.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const base = '/api/workflow-schedules';
  assert.equal((await request(base, 'GET', undefined, { authorization: '' })).status, 401);
  assert.equal((await request(base, 'POST', {}, { authorization: 'Bearer test', ...{ origin: 'https://untrusted.invalid' } })).status, 403);
  for (const invalid of [{ ...settings, concurrency: 101 }, { ...settings, timing: { kind: 'daily', time: '09:00', timezone: 'Invalid/Zone' } }, { ...settings, sessionId: 'injected' }]) assert.equal((await request(base, 'POST', { settings: invalid })).status, 400);
  assert.equal((await request(base, 'POST', { settings, owner: 'injected' })).status, 400);
  const created = await request(base, 'POST', { settings, enabled: true });
  assert.equal(created.status, 201);
  const { schedule } = await created.json() as { schedule: WorkflowSchedule };
  assert.equal(schedule.nextDue, 61_000);
  assert.equal((await request(`${base}/${schedule.id}`, 'PUT', { settings, enabled: true, revision: 2 })).status, 409);
  dependencyError = Object.assign(new Error('Deleted workflow'), { code: 'ENOENT' });
  assert.equal((await request(`${base}/${schedule.id}/pause`, 'POST', { revision: 2 })).status, 409);
  assert.equal(store.getSchedule(schedule.id).enabled, true);
  assert.equal((await request(`${base}/${schedule.id}/pause`, 'POST', { revision: 1 })).status, 200);
  assert.equal(store.getSchedule(schedule.id).enabled, false);
  assert.equal(store.getSchedule(schedule.id).nextDue, undefined);
  assert.deepEqual(occurrenceSettings(store.getSchedule(schedule.id)), settings);
  for (const message of ['Deleted workflow', 'Missing Project', 'Missing branch', 'Missing MCP']) {
    dependencyError = new ScheduleValidationError(message);
    assert.equal((await request(`${base}/${schedule.id}/enable`, 'POST', { revision: 2 })).status, 400);
    assert.equal(store.getSchedule(schedule.id).enabled, false);
  }
  const diagnostics: string[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => { diagnostics.push(values.map(String).join(' ')); });
  for (const failure of [new Error('synthetic-private-detail'), new SyntaxError('synthetic-private-detail'), new z.ZodError([]), Object.assign(new Error('synthetic-private-detail'), { status: 413 }),
    Object.assign(new Error('synthetic-private-detail'), { code: 'EIO' }), Object.assign(new Error('synthetic-private-detail'), { code: 'ENOENT' })]) {
    dependencyError = failure;
    const response = await request(`${base}/${schedule.id}/enable`, 'POST', { revision: 2 });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /synthetic-private-detail/);
    assert.equal(store.getSchedule(schedule.id).enabled, false);
  }
  assert.equal(diagnostics.length, 6);
  assert.doesNotMatch(diagnostics.join('\n'), /synthetic-private-detail/);
  try {
    resolveWorkflowCalls({ version: 1, id: 'root', name: 'Root', backend: 'fake', inputSchema: { type: 'object', fields: {} }, edges: [],
      steps: [{ kind: 'workflow', id: 'call', name: 'Call', workflowId: 'missing', contract: { inputSchema: { type: 'object', fields: {} }, outputSchema: { type: 'number' } } }] },
    () => { throw Object.assign(new Error('synthetic-private-detail'), { code: 'ENOENT' }); });
  } catch (error) { dependencyError = error as Error; }
  assert.ok(dependencyError instanceof WorkflowValidationError);
  assert.equal((await request(`${base}/${schedule.id}/enable`, 'POST', { revision: 2 })).status, 400);
  dependencyError = new WorkflowConflict();
  assert.equal((await request(`${base}/${schedule.id}/enable`, 'POST', { revision: 2 })).status, 409);
  const malformed = await fetch(server.url + base, { method: 'POST', headers: { authorization: 'Bearer test' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(diagnostics.length, 6);
  const occurrence = { version: 1 as const, id: occurrenceId(schedule.id, 1, 61_000), scheduleId: schedule.id, activation: 1, revision: 1, scheduledAt: 61_000, createdAt: 61_000, finishedAt: 61_000, settings: occurrenceSettings(schedule), status: 'capacity-skipped' as const };
  store.claimOccurrence(occurrence);
  assert.equal((await request(`${base}/${schedule.id}`, 'DELETE', { revision: 2 })).status, 200);
  const history = await request(`${base}/${schedule.id}/history?limit=1`);
  assert.equal(history.status, 200); assert.equal((await history.json() as WorkflowOccurrencePage).occurrences[0]!.id, occurrence.id);
  assert.equal((await request(`/api/workflow-occurrences/${occurrence.id}`)).status, 200);
  assert.equal((await request(`/api/workflow-occurrences/${occurrence.id}/execution`)).status, 404);
  assert.equal((await request(`/api/workflow-occurrences/${occurrence.id}/activity`)).status, 404);
  const activityOccurrence = { version: 1 as const, id: occurrenceId(schedule.id, 1, 62_000), scheduleId: schedule.id, activation: 1, revision: 1,
    scheduledAt: 62_000, createdAt: 62_000, settings: occurrenceSettings(schedule), status: 'running' as const, executionId: 'fixture-execution' };
  store.claimOccurrence(activityOccurrence);
  const activity = t.mock.method(executions, 'activity', async () => { throw new Error('Invalid cursor reached activity'); });
  for (const query of ['after=1&before=2', 'after=1&latest=true', 'before=0', 'attempt=0', 'limit=0']) {
    assert.equal((await request(`/api/workflow-occurrences/${activityOccurrence.id}/activity?${query}`)).status, 400);
  }
  assert.equal(activity.mock.callCount(), 0);
  assert.equal((await request(`${base}/${schedule.id}/history?limit=0`)).status, 400);
  assert.equal((await request(`${base}/${schedule.id}/history?limit=1&limit=2`)).status, 400);
  assert.equal((await request(`${base}/${schedule.id}/history?before=absent`)).status, 400);
  assert.equal((await request(`${base}/${schedule.id}/history?before=invalid%2Fcursor`)).status, 400);
  assert.equal((await request(`${base}/${schedule.id}/history?before=${'9'.repeat(40)}_${'a'.repeat(64)}`)).status, 400);
  assert.equal((await request(base, 'POST', { padding: 'x'.repeat(1_000_001) })).status, 413);
  assert.equal((await request(`${base}/preview`, 'POST', { timing: settings.timing })).status, 200);
  assert.equal((await request(`${base}/%2Fescape`)).status, 400);
  assert.equal((await request(`${base}/absent`)).status, 404);
});
