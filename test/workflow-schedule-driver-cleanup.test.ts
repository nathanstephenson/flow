import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { scheduleDriver } from '../src/daemon/workflow-schedule-driver.ts';
import { WorkflowScheduleService } from '../src/daemon/workflow-schedules.ts';
import { WorkflowScheduleStore } from '../src/workflows/schedule-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { createSchedule, occurrenceId, occurrenceSettings } from '../src/workflows/schedules.ts';
import type { WorkflowOccurrence } from '../src/protocol/workflow-schedules.ts';
import { fakeProvider } from './backend/sandbox-fixture.ts';
import { git, repository } from './git-fixture.ts';

async function fixture(t: import('node:test').TestContext, patch: Partial<WorkflowOccurrence> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-schedule-cleanup-'));
  const repo = repository(root, 'project', ['release']), state = join(root, 'state');
  const provider = fakeProvider(t);
  const config = new ConfigStore(state); config.update({ filesystemIsolation: 'none', workflowRuntime: { nodePath: process.execPath }, projects: { include: [repo] } });
  const transcripts = new TranscriptStore(state), workflows = new WorkflowStore(state), schedules = new WorkflowScheduleStore(state);
  const host = new SessionHost({ store: transcripts, retention: 0, filesystemIsolationMode: () => 'none', sandboxSupport: () => provider.support });
  const executions = new WorkflowExecutionService(host, workflows, new SecretStore(state), config, join(root, 'unused-runtime.cjs'));
  workflows.saveDefinition({ version: 1, id: 'check', name: 'Check', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'done', name: 'Done', kind: 'join' }], edges: [] });
  await host.load();
  t.after(async () => { await executions.stopScheduled(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const driver = scheduleDriver({ host, config, workflows, executions, schedules, transcripts });
  const schedule = createSchedule({ name: 'Scheduled', workflowId: 'check', input: {}, projectId: repo, mcpConnectionIds: [], worktree: { from: 'release' }, timing: { kind: 'interval', value: 1, unit: 'minutes' }, concurrency: 1 }, 0, true);
  schedules.saveSchedule(schedule);
  const path = join(root, 'worktree'), branch = 'flow/scheduled';
  git(repo, 'worktree', 'add', '--quiet', '-b', branch, path, 'release');
  const occurrence: WorkflowOccurrence = { version: 1, id: occurrenceId(schedule.id, 1, 60_000), scheduleId: schedule.id, activation: 1, revision: 1, scheduledAt: 60_000, createdAt: 60_000, settings: occurrenceSettings(schedule), status: 'interrupted', finishedAt: 61_000, scope: path, worktree: { path, repo, branch }, ...patch };
  schedules.claimOccurrence(occurrence);
  const owner = workflows.ownerPath(`occurrence-${occurrence.id}`), journal = join(owner, 'sandbox.json');
  mkdirSync(owner, { recursive: true });
  writeFileSync(journal, JSON.stringify({ schemaVersion: '1', name: `flow-occurrence-${occurrence.id}` }));
  return { root, repo, path, branch, owner, journal, host, transcripts, workflows, executions, schedules, driver, occurrence, provider };
}

test('a failed branch removal stays pending across restart and clears its warning after retry', { timeout: 10_000 }, async t => {
  const f = await fixture(t), before = f.schedules.getStoredOccurrence(f.occurrence.id);
  const lock = join(f.repo, '.git', 'refs', 'heads', `${f.branch}.lock`);
  writeFileSync(lock, '');
  const first = new WorkflowScheduleService(f.schedules, f.driver, () => 61_000);
  await first.start(false); await first.stopAdmission();
  assert.ok(git(f.repo, 'branch', '--list', f.branch).trim());
  assert.ok(f.schedules.pendingUnstartedCleanup().includes(f.occurrence.id));
  assert.equal(f.schedules.cleanupWarnings().length, 1);
  rmSync(lock);
  const reloaded = new WorkflowScheduleStore(join(f.root, 'state'));
  const second = new WorkflowScheduleService(reloaded, f.driver, () => 61_000);
  await second.start(false); await second.stopAdmission();
  assert.equal(existsSync(f.path), false);
  assert.equal(git(f.repo, 'branch', '--list', f.branch).trim(), '');
  assert.equal(reloaded.pendingUnstartedCleanup().includes(f.occurrence.id), false);
  assert.deepEqual(reloaded.cleanupWarnings(), []);
  assert.deepEqual(reloaded.getStoredOccurrence(f.occurrence.id), before);
});

for (const absent of [false, true]) {
  test(`cleanup uses the saved local base for tree and branch removal (absent=${absent})`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    git(f.repo, 'tag', 'release');
    git(f.path, 'commit', '--quiet', '--allow-empty', '-m', 'scheduled result');
    const result = git(f.path, 'rev-parse', 'HEAD').trim();
    git(f.repo, 'update-ref', 'refs/heads/release', result);
    git(f.repo, 'switch', '--quiet', '-c', 'unrelated');
    git(f.repo, 'commit', '--quiet', '--allow-empty', '-m', 'unrelated work');
    const checkout = git(f.repo, 'rev-parse', 'HEAD');
    git(f.repo, 'config', `branch.${f.branch}.remote`, '.');
    git(f.repo, 'config', `branch.${f.branch}.merge`, 'refs/heads/unrelated');
    const config = git(f.repo, 'config', '--list');
    if (absent) git(f.repo, 'worktree', 'remove', f.path);
    await f.driver.cleanup(f.occurrence);
    assert.equal(existsSync(f.path), false);
    assert.equal(git(f.repo, 'branch', '--list', f.branch).trim(), '');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), checkout);
    assert.equal(git(f.repo, 'symbolic-ref', '--short', 'HEAD').trim(), 'unrelated');
    assert.equal(git(f.repo, 'rev-parse', 'refs/heads/release').trim(), result);
    assert.equal(git(f.repo, 'config', '--list').includes('flow-cleanup-'), false);
    assert.ok(config.includes('branch.flow/scheduled.merge=refs/heads/unrelated'));
    assert.equal(f.schedules.cleanupWarnings().length, 0);
  });
}

for (const absent of [false, true]) {
  test(`cleanup preserves work not merged into the saved base (absent=${absent})`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    git(f.path, 'commit', '--quiet', '--allow-empty', '-m', 'unmerged result');
    const head = git(f.path, 'rev-parse', 'HEAD').trim();
    git(f.repo, 'merge', '--quiet', '--ff-only', f.branch);
    if (absent) git(f.repo, 'worktree', 'remove', f.path);
    await f.driver.cleanup(f.occurrence);
    assert.equal(existsSync(f.path), !absent);
    assert.equal(git(f.repo, 'rev-parse', `refs/heads/${f.branch}`).trim(), head);
    assert.equal(f.schedules.cleanupWarnings().length, 1);
  });
}

for (const status of ['interrupted', 'cancelled', 'launch-failed'] as const) {
  test(`unstarted ${status} cleanup is prompt, keeps history and is repeatable`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { status }), occurrence = f.occurrence;
    await f.driver.cleanupUnstarted!(occurrence);
    await f.driver.cleanupUnstarted!(occurrence);
    assert.deepEqual(f.schedules.getOccurrence(occurrence.id), occurrence);
    assert.equal(existsSync(f.path), false);
    assert.equal(git(f.repo, 'branch', '--list', f.branch).trim(), '');
    assert.equal(existsSync(f.owner), false);
    assert.equal(f.provider.calls().filter(call => call.startsWith('remove ')).length, 1);
  });
}

test('unstarted cleanup retains its environment journal and tree on removal failure, then retries', { timeout: 10_000 }, async t => {
  const f = await fixture(t), remove = f.provider.support.provider.remove;
  f.provider.support.provider.remove = ['/bin/false', '{name}'];
  await assert.rejects(f.driver.cleanupUnstarted!(f.occurrence), /Sandbox provider/);
  assert.equal(existsSync(f.journal), true);
  assert.equal(existsSync(f.path), true);
  assert.deepEqual(f.schedules.getOccurrence(f.occurrence.id), f.occurrence);
  f.provider.support.provider.remove = remove;
  await f.driver.cleanupUnstarted!(f.occurrence);
  assert.equal(existsSync(f.owner), false);
  assert.equal(existsSync(f.path), false);
});

test('restart records interruption before failed reclamation and never replays provisioning', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { status: 'provisioning', finishedAt: undefined }), occurrence = f.occurrence;
  const launch = t.mock.method(f.executions, 'startScheduled'), remove = f.provider.support.provider.remove;
  f.provider.support.provider.remove = ['/bin/false', '{name}'];
  await assert.rejects(f.driver.reconcile(occurrence), /Sandbox provider/);
  const saved = new WorkflowScheduleStore(join(f.schedules.root, '..')).getOccurrence(occurrence.id);
  assert.equal(saved.status, 'interrupted');
  assert.ok(saved.finishedAt);
  assert.equal(f.schedules.activeCount(), 0);
  assert.equal(existsSync(f.journal), true);
  f.provider.support.provider.remove = remove;
  await f.driver.reconcile(occurrence);
  assert.deepEqual(f.schedules.getOccurrence(occurrence.id), saved);
  assert.equal(existsSync(f.path), false);
  assert.equal(existsSync(f.owner), false);
  assert.equal(launch.mock.callCount(), 0);
});

for (const guard of ['execution-id', 'checkpoint', 'corrupt-checkpoint', 'session', 'pending', 'failed', 'active'] as const) {
  test(`unstarted cleanup preserves uncertain ownership: ${guard}`, { timeout: 10_000 }, async t => {
    const patch: Partial<WorkflowOccurrence> = guard === 'execution-id' ? { executionId: 'uncertain' }
      : guard === 'session' ? { sessionId: 'associated' }
      : guard === 'pending' || guard === 'failed' ? { association: guard }
      : guard === 'active' ? { status: 'provisioning', finishedAt: undefined } : {};
    const f = await fixture(t, patch), occurrence = f.occurrence;
    if (guard === 'checkpoint') f.workflows.saveExecution({ version: 2, occurrenceId: occurrence.id, id: 'started', scope: f.path, definition: f.workflows.getDefinition('check'), input: {}, steps: { done: { status: 'pending', attempts: [] } }, startedAt: 60_000, status: 'running' });
    if (guard === 'corrupt-checkpoint') {
      mkdirSync(join(f.owner, 'workflows'), { recursive: true });
      writeFileSync(join(f.owner, 'workflows', 'uncertain.json'), '{}');
      await assert.rejects(f.driver.cleanupUnstarted!(occurrence));
    } else await f.driver.cleanupUnstarted!(occurrence);
    assert.equal(existsSync(f.journal), true);
    assert.equal(existsSync(f.path), true);
    assert.equal(git(f.repo, 'branch', '--list', f.branch).trim().length > 0, true);
    assert.deepEqual(f.schedules.getOccurrence(occurrence.id), occurrence);
    if (guard === 'checkpoint') f.workflows.deleteOwner(`occurrence-${occurrence.id}`);
  });
}

test('unstarted cleanup cannot reclaim live provisioning even with a terminal summary', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { status: 'provisioning', finishedAt: undefined });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.executions, 'startScheduled', async () => { entered(); await blocked; throw new Error('Provisioning stopped'); });
  const launching = f.driver.launch(f.occurrence);
  const stopped = assert.rejects(launching, /Provisioning stopped/);
  t.after(() => release());
  await started;
  const occurrence: WorkflowOccurrence = { ...f.schedules.getOccurrence(f.occurrence.id), status: 'cancelled', finishedAt: 61_000 };
  f.schedules.saveOccurrence(occurrence);
  await f.driver.cleanupUnstarted!(occurrence);
  assert.equal(existsSync(f.journal), true);
  assert.equal(existsSync(occurrence.worktree!.path), true);
  release();
  await stopped;
  await f.driver.cleanupUnstarted!(occurrence);
  assert.equal(existsSync(f.owner), false);
  assert.equal(existsSync(occurrence.worktree!.path), false);
});

for (const dirty of [false, true]) {
  test(`unstarted cleanup preserves unsafe work and records a warning (dirty=${dirty})`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    if (dirty) writeFileSync(join(f.path, 'unsaved'), 'Important work');
    else git(f.path, 'commit', '--quiet', '--allow-empty', '-m', 'unmerged result');
    const head = git(f.path, 'rev-parse', 'HEAD');
    await f.driver.cleanupUnstarted!(f.occurrence);
    assert.equal(existsSync(f.path), true);
    assert.equal(git(f.path, 'rev-parse', 'HEAD'), head);
    assert.ok(git(f.repo, 'branch', '--list', f.branch).trim());
    assert.equal(f.schedules.cleanupWarnings().length, 1);
    assert.deepEqual(f.schedules.getOccurrence(f.occurrence.id), f.occurrence);
    assert.equal(existsSync(f.owner), false);
  });
}

test('missing saved base preserves tree and ref even if the current checkout includes the result', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  git(f.repo, 'branch', '-d', 'release');
  await f.driver.cleanup(f.occurrence);
  assert.equal(existsSync(f.path), true);
  assert.ok(git(f.repo, 'branch', '--list', f.branch).trim());
  assert.equal(f.schedules.cleanupWarnings().length, 1);
});

test('unstarted cleanup reads current ownership rather than its stale argument', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { status: 'provisioning', finishedAt: undefined });
  f.schedules.saveOccurrence({ ...f.occurrence, status: 'interrupted', finishedAt: 61_000, sessionId: 'associated', association: 'attached' });
  await f.driver.cleanupUnstarted!(f.occurrence);
  assert.equal(existsSync(f.journal), true);
  assert.equal(existsSync(f.path), true);
});
