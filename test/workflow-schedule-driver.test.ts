import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { WorkflowEnvironment } from '../src/daemon/workflow-environment.ts';
import { fakeProvider } from './backend/sandbox-fixture.ts';
import { scheduleDriver } from '../src/daemon/workflow-schedule-driver.ts';
import { WorkflowScheduleService } from '../src/daemon/workflow-schedules.ts';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { createSchedule, occurrenceId, occurrenceSettings, SCHEDULE_RETENTION_MS } from '../src/workflows/schedules.ts';
import type { WorkflowOccurrence } from '../src/protocol/workflow-schedules.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import { git, repository } from './git-fixture.ts';

const definition: WorkflowDefinition = { version: 1, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'done', name: 'Done', kind: 'join' }], edges: [] };
async function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedule-driver-'));
  const repo = repository(root, 'project'), state = join(root, 'state');
  const config = new ConfigStore(state); config.update({ filesystemIsolation: 'none', workflowRuntime: { nodePath: process.execPath }, projects: { include: [repo] } });
  const transcripts = new TranscriptStore(state), workflows = new WorkflowStore(state), schedules = new WorkflowScheduleStore(state);
  const host = new SessionHost({ store: transcripts, retention: 0, filesystemIsolationMode: () => 'none' });
  const executions = new WorkflowExecutionService(host, workflows, new SecretStore(state), config, join(root, 'unused-runtime.cjs'));
  workflows.saveDefinition(definition); await host.load();
  t.after(async () => { await executions.stopScheduled(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const driver = scheduleDriver({ host, config, workflows, executions, schedules, transcripts });
  const settings = { name: 'Scheduled', workflowId: definition.id, input: {}, projectId: repo, mcpConnectionIds: [], timing: { kind: 'interval' as const, value: 1, unit: 'minutes' as const }, concurrency: 1 };
  const schedule = createSchedule(settings, 0, true); schedules.saveSchedule(schedule);
  const occurrence: WorkflowOccurrence = { version: 1, id: occurrenceId(schedule.id, 1, 60_000), scheduleId: schedule.id, activation: 1, revision: 1, scheduledAt: 60_000, createdAt: 60_000, settings: occurrenceSettings(schedule), status: 'provisioning' };
  return { root, repo, host, workflows, executions, schedules, driver, schedule, occurrence };
}
for (const state of ['dirty', 'detached-unmerged', 'detached-merged', 'changed-branch', 'unmerged', 'merged'] as const) {
  test(`retention checks the current Worktree HEAD: ${state}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), path = join(f.root, 'worktree'), branch = 'flow/scheduled';
    git(f.repo, 'worktree', 'add', '--quiet', '-b', branch, path, 'main');
    if (state.startsWith('detached')) git(path, 'switch', '--quiet', '--detach');
    if (state === 'changed-branch') git(path, 'switch', '--quiet', '-c', 'other-work');
    if (state === 'dirty') writeFileSync(join(path, 'unsaved'), 'Keep this file');
    else if (state !== 'merged' && state !== 'detached-merged') {
      writeFileSync(join(path, 'result'), 'Important work'); git(path, 'add', '.'); git(path, 'commit', '--quiet', '-m', 'work');
    }
    const head = git(path, 'rev-parse', 'HEAD').trim();
    const occurrence: WorkflowOccurrence = { ...f.occurrence, settings: { ...f.occurrence.settings, worktree: { from: 'main' } }, status: 'completed', finishedAt: 61_000, worktree: { path, repo: f.repo, branch } };
    f.schedules.claimOccurrence(occurrence);
    await f.driver.cleanup(occurrence);
    if (state === 'merged') {
      assert.equal(existsSync(path), false); assert.equal(f.schedules.cleanupWarnings().length, 0);
      assert.ok(!git(f.repo, 'branch', '--list', branch).trim());
    } else {
      assert.equal(existsSync(path), true);
      assert.equal(git(path, 'rev-parse', 'HEAD').trim(), head);
      assert.ok(git(f.repo, 'branch', '--list', branch).trim());
      assert.equal(f.schedules.cleanupWarnings().length, 1);
    }
  });
}
for (const change of [{ model: 'missing', effort: 'high' }, { model: 'fake-1', effort: 'max' }] as const) {
  test(`driver rejects ${JSON.stringify(change)} before Git or execution effects`, { timeout: 10_000 }, async t => {
    const f = await fixture(t), backend = new FakeBackend();
    f.host.registerBackend(backend);
    f.workflows.saveDefinition({ ...definition, steps: [{ id: 'agent', name: 'Agent', kind: 'agent', ...change, instructions: 'JSON', outputSchema: { type: 'string' } }] });
    const occurrence = { ...f.occurrence, settings: { ...f.occurrence.settings, worktree: { from: 'main' } } };
    f.schedules.claimOccurrence(occurrence);
    const start = t.mock.method(f.executions, 'startScheduled');
    await assert.rejects(f.driver.validate(occurrence.settings), /unavailable|unsupported/);
    await assert.rejects(f.driver.launch(occurrence), /unavailable|unsupported/);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(f.schedules.getOccurrence(occurrence.id).worktree, undefined);
    assert.deepEqual(f.workflows.listExecutions(`occurrence-${occurrence.id}`), []);
    assert.deepEqual(f.host.list(), []);
    assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)!.length, 1);
    assert.equal(backend.sessions.length, 1);
    assert.equal(backend.sessions[0]!.toolless, true);
    assert.deepEqual(backend.sessions[0]!.prompts, []);
    assert.deepEqual(backend.sessions[0]!.workflowSubagents, []);
  });
}

test('aborting pre-start validation prevents Worktree and execution effects', { timeout: 10_000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const occurrence = { ...f.occurrence, settings: { ...f.occurrence.settings, worktree: { from: 'main' } } };
  f.schedules.claimOccurrence(occurrence);
  const start = t.mock.method(f.executions, 'startScheduled');
  const launching = f.driver.launch(occurrence, controller.signal);
  controller.abort();
  await assert.rejects(launching, { name: 'AbortError' });
  assert.equal(start.mock.callCount(), 0);
  assert.equal(f.schedules.getOccurrence(occurrence.id).worktree, undefined);
  assert.equal(f.workflows.listExecutions(`occurrence-${occurrence.id}`).length, 0);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)!.length, 1);
});
test('driver forwards provisioning cancellation and reads the durable execution owner, not occurrence status', { timeout: 10_000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  f.schedules.claimOccurrence(f.occurrence);
  let now = 0;
  const service = new WorkflowScheduleService(f.schedules, f.driver, () => now);
  const start = t.mock.method(f.executions, 'startScheduled');
  await f.driver.launch(f.occurrence, controller.signal);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(start.mock.calls[0]!.arguments[0].signal, controller.signal);
  const initial = f.driver.current!(f.occurrence)!;
  const record = await f.executions.scheduler.wait(`occurrence-${f.occurrence.id}`, initial.id);
  const save = f.schedules.saveOccurrence.bind(f.schedules);
  let failures = 1;
  f.schedules.saveOccurrence = value => { if (value.status === 'completed' && failures-- > 0) throw new Error('status write failed'); save(value); };
  assert.throws(() => service.result(record), /status write failed/);
  assert.equal(f.driver.current!(f.occurrence)!.status, 'completed');
  assert.notEqual(new WorkflowScheduleStore(join(f.schedules.root, '..')).getOccurrence(f.occurrence.id).status, 'completed');
  assert.equal(f.schedules.page().occurrences[0]!.status, 'completed');
  assert.equal(service.hasActiveWork(), false);
  assert.equal(f.host.list().length, 0);
  now = record.finishedAt! + SCHEDULE_RETENTION_MS;
  assert.deepEqual(await service.prune(), [f.occurrence.id]);
});
test('retention closes a live environment before reclaiming its journal, without duplicate Sandbox removal', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const provider = fakeProvider(t, 'cp "$1" "$LOG/spec.json"; touch "$LOG/alive"; echo create >> "$LOG/calls"', 'test -f "$LOG/alive" || exit 1; rm "$LOG/alive"; echo "remove $1" >> "$LOG/calls"');
  const host = new SessionHost({ sandboxSupport: () => provider.support });
  const environment = new WorkflowEnvironment(host, `occurrence-${f.occurrence.id}`, f.repo, [], 'sandbox', f.workflows.ownerPath(`occurrence-${f.occurrence.id}`));
  t.after(async () => { await environment.close().catch(() => {}); });
  await environment.prepare();
  const remove = provider.support.provider.remove;
  provider.support.provider.remove = ['/bin/false', '{name}'];
  await assert.rejects(environment.close(), AggregateError);
  provider.support.provider.remove = remove;
  t.mock.method(f.executions, 'expireScheduled', () => environment.close());
  await f.driver.cleanup({ ...f.occurrence, status: 'completed', finishedAt: 61_000 });
  assert.equal(provider.calls().filter(call => call.startsWith('remove ')).length, 1);
  assert.equal(existsSync(join(f.workflows.ownerPath(`occurrence-${f.occurrence.id}`), 'sandbox.json')), false);
});

test('failed environment cleanup retains occurrence history and its execution checkpoint for retry', { timeout: 10_000 }, async t => {
  const f = await fixture(t); f.schedules.claimOccurrence(f.occurrence);
  await f.driver.launch(f.occurrence);
  const initial = f.schedules.getOccurrence(f.occurrence.id);
  const record = await f.executions.scheduler.wait(`occurrence-${initial.id}`, initial.executionId!);
  new WorkflowScheduleService(f.schedules, f.driver).result(record);
  const occurrence = f.schedules.getOccurrence(f.occurrence.id);
  assert.equal(occurrence.status, 'completed');
  const owner = f.workflows.ownerPath(`occurrence-${occurrence.id}`);
  writeFileSync(join(owner, 'sandbox.json'), '{}');
  const expire = t.mock.method(f.executions, 'expireScheduled');
  const time = occurrence.finishedAt! + SCHEDULE_RETENTION_MS;
  assert.deepEqual(await f.schedules.prune(time, value => f.driver.cleanup(value)), []);
  assert.equal(expire.mock.callCount(), 1);
  assert.equal(f.schedules.getOccurrence(occurrence.id).executionId, occurrence.executionId);
  assert.equal(f.workflows.getExecution(`occurrence-${occurrence.id}`, occurrence.executionId!).status, 'completed');
  assert.equal(existsSync(join(owner, 'sandbox.json')), true);
  rmSync(join(owner, 'sandbox.json'));
  assert.deepEqual(await f.schedules.prune(time, value => f.driver.cleanup(value)), [occurrence.id]);
});
