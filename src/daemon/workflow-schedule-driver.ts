import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { removeOwnedSandbox, sandboxUnavailable } from '../isolation/sandbox.ts';
import type { WorkflowOccurrence, WorkflowScheduleSettings } from '../protocol/workflow-schedules.ts';
import { isActiveOccurrence, projectExecution } from '../workflows/schedules.ts';
import { ScheduledExecutionStarted, type ScheduleDriver } from './workflow-schedules.ts';
import type { WorkflowExecutionService } from './workflow-executions.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import type { WorkflowScheduleStore } from '../workflows/schedule-store.ts';
import type { TranscriptStore } from './store.ts';
import type { SessionHost } from './host.ts';
import type { ConfigStore } from './config-store.ts';
import { resolveWorkflowCalls } from '../workflows/calls.ts';
import { ScheduleValidationError } from '../workflows/schedule-errors.ts';
import { includedProjects } from './projects.ts';
import { isClean, localBranches, planWorktree, removeMergedBranch, removeWorktree, run, GIT_WRITE_TIMEOUT_MS } from './git.ts';

export function scheduleDriver(options: { host: SessionHost; config: ConfigStore; workflows: WorkflowStore; executions: WorkflowExecutionService; schedules: WorkflowScheduleStore; transcripts: TranscriptStore }): ScheduleDriver {
  const { host, config, workflows, executions, schedules, transcripts } = options;
  const repositories = new Map<string, Promise<unknown>>();
  const provisioning = new Set<string>();
  function current(occurrence: WorkflowOccurrence) {
    const owner = `occurrence-${occurrence.id}`;
    return occurrence.executionId ? workflows.getExecution(owner, occurrence.executionId) : workflows.listExecutions(owner)[0];
  }
  function definition(id: string) {
    try { return workflows.getDefinition(id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ScheduleValidationError('Select an available Workflow Definition');
      throw error;
    }
  }
  async function validate(settings: WorkflowScheduleSettings): Promise<void> {
    const projects = includedProjects(config.rawProjectRoot(), config.projectInclude());
    const project = projects.find(project => project.path === settings.projectId && !project.missing);
    if (!project || realpathSync(project.path) !== settings.projectId) throw new ScheduleValidationError('Select an available opted-in Project');
    host.scheduledConnections(settings.mcpConnectionIds);
    const selected = definition(settings.workflowId);
    const manifest = resolveWorkflowCalls(selected, definition);
    for (const candidate of Object.values(manifest)) {
      executions.validateDefinitionCredentials(candidate);
      for (const step of candidate.steps) if (step.kind === 'mcp' && !settings.mcpConnectionIds.includes(step.tool.connectionId)) throw new ScheduleValidationError('Workflow MCP connection must be selected');
    }
    if (settings.worktree) {
      const branches = await localBranches(settings.projectId);
      if (!branches.ok) throw new Error('Local branch inspection is unavailable');
      if (!branches.value.includes(settings.worktree.from)) throw new ScheduleValidationError('Select an existing local base branch');
    }
    await executions.validateScheduledAgents(selected, settings.input, settings.projectId);
  }
  async function reclaimEnvironment(occurrence: WorkflowOccurrence): Promise<void> {
    const path = join(workflows.ownerPath(`occurrence-${occurrence.id}`), 'sandbox.json');
    if (!existsSync(path)) return;
    const support = host.sandboxSupport();
    if (!support?.supported) throw sandboxUnavailable();
    await removeOwnedSandbox(support.provider, path, `flow-occurrence-${occurrence.id}`);
  }
  async function reclaimWorktree(occurrence: WorkflowOccurrence): Promise<boolean> {
    const worktree = occurrence.worktree;
    if (!worktree) return true;
    const preserve = (warning: string) => { schedules.saveCleanupWarning(occurrence, warning); return false; };
    const retry = (warning: string): never => {
      schedules.saveCleanupWarning(occurrence, warning);
      throw new Error('Workflow Occurrence Git cleanup is unavailable. Owned work is retained for retry.');
    };
    const from = occurrence.settings.worktree?.from;
    if (!from) return preserve('Worktree preserved: saved base unavailable. Manual review required.');
    const baseRef = `refs/heads/${from}`, branchRef = `refs/heads/${worktree.branch}`;
    const base = await run(worktree.repo, ['show-ref', '--verify', '--quiet', baseRef], 10_000);
    if (!base.ok) return base.failure.code === 1 ? preserve('Worktree preserved: saved base unavailable. Manual review required.') : retry('Saved base inspection failed. Cleanup will be retried.');
    const presentPath = existsSync(worktree.path);
    if (presentPath) {
      const clean = await isClean(worktree.path);
      if (!clean.ok) return retry('Worktree inspection failed. Cleanup will be retried.');
      if (!clean.value) return preserve('Worktree preserved: dirty. Manual review required.');
      const branch = await run(worktree.path, ['symbolic-ref', '--quiet', 'HEAD'], 10_000);
      if (!branch.ok) return branch.failure.code === 1 ? preserve('Worktree preserved: detached. Manual review required.') : retry('Worktree branch inspection failed. Cleanup will be retried.');
      if (branch.value.trim() !== branchRef) return preserve('Worktree preserved: changed branch. Manual review required.');
      const head = await run(worktree.path, ['rev-parse', 'HEAD'], 10_000);
      if (!head.ok) return retry('Worktree HEAD inspection failed. Cleanup will be retried.');
      const merged = await run(worktree.repo, ['merge-base', '--is-ancestor', head.value.trim(), baseRef], 10_000);
      if (!merged.ok) return merged.failure.code === 1 ? preserve('Worktree preserved: unmerged. Manual review required.') : retry('Worktree merge inspection failed. Cleanup will be retried.');
      if (!(await removeWorktree(worktree)).ok) retry('Worktree removal failed. Cleanup will be retried.');
    }
    const present = await run(worktree.repo, ['show-ref', '--verify', '--quiet', branchRef], 10_000);
    if (!present.ok) return present.failure.code === 1 ? true : retry('Branch inspection failed. Cleanup will be retried.');
    const merged = await run(worktree.repo, ['merge-base', '--is-ancestor', branchRef, baseRef], 10_000);
    if (!merged.ok) return merged.failure.code === 1 ? preserve('Branch preserved: unmerged. Manual review required.') : retry('Branch merge inspection failed. Cleanup will be retried.');
    if (!(await removeMergedBranch(worktree.repo, worktree.branch, from)).ok) retry('Branch removal failed. Cleanup will be retried.');
    return true;
  }
  async function cleanupResources(occurrence: WorkflowOccurrence): Promise<void> {
    await executions.expireScheduled(occurrence.id);
    await reclaimEnvironment(occurrence);
    const session = occurrence.sessionId ? transcripts.readMeta(occurrence.sessionId) : undefined;
    const reclaimed = session?.scheduledOccurrenceId === occurrence.id || await reclaimWorktree(occurrence);
    workflows.deleteOwner({ kind: 'occurrence', occurrenceId: occurrence.id });
    if (reclaimed) schedules.clearCleanupWarning(occurrence.id);
  }
  async function cleanupUnstarted(initial: WorkflowOccurrence): Promise<void> {
    const occurrence = schedules.getOccurrence(initial.id);
    if (provisioning.has(occurrence.id) || !['interrupted', 'cancelled', 'launch-failed'].includes(occurrence.status)
      || occurrence.executionId || occurrence.sessionId || occurrence.association
      || workflows.listExecutions(`occurrence-${occurrence.id}`).length) return;
    await cleanupResources(occurrence);
  }
  const attachment = (id: string) => async () => {
    let occurrence = schedules.getOccurrence(id);
    const sessionId = occurrence.sessionId ?? randomUUID();
    // Intent is durable before host creation. The host also writes its occurrence association
    // before backend creation; retries always reuse this identity, never a second session.
    if (!occurrence.sessionId) { occurrence = { ...occurrence, sessionId, association: 'pending' }; schedules.saveOccurrence(occurrence); }
    if (!occurrence.scope) throw new Error('Occurrence Scope unavailable');
    const definition = workflows.listExecutions(`occurrence-${id}`)[0]?.definition;
    if (!definition) throw new Error('Retained execution unavailable');
    try {
      const result = await host.attachScheduled({ scope: occurrence.scope, backend: definition.backend, mcpConnectionIds: occurrence.settings.mcpConnectionIds,
        scheduled: { id: sessionId, occurrenceId: id, ...(occurrence.worktree ? { worktree: occurrence.worktree } : {}) } });
      schedules.saveOccurrence({ ...schedules.getOccurrence(id), association: 'attached' });
      return result;
    } catch (error) {
      schedules.saveOccurrence({ ...schedules.getOccurrence(id), association: 'failed', outcome: 'Agent Session attachment failed. Restore backend availability and retry attachment; the workflow will not replay automatically.' });
      throw error;
    }
  };
  return {
    validate,
    current,
    async launch(initial, signal) {
      provisioning.add(initial.id);
      try {
        signal?.throwIfAborted();
        await validate(initial.settings);
        signal?.throwIfAborted();
        let occurrence = schedules.getOccurrence(initial.id);
        let scope = occurrence.settings.projectId;
        if (occurrence.settings.worktree) {
          const repo = scope;
          const previous = repositories.get(repo) ?? Promise.resolve();
          const provision = previous.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            const from = occurrence.settings.worktree!.from;
            const planned = await planWorktree({ repo, from, branch: `flow/schedule-${occurrence.id}`, under: transcripts.worktreesRoot() });
            if (!planned.ok) throw new Error('Could not plan worktree');
            signal?.throwIfAborted();
            occurrence = { ...occurrence, worktree: { ...planned.value, repo } };
            schedules.saveOccurrence(occurrence);
            const created = await run(repo, ['worktree', 'add', '-b', planned.value.branch, planned.value.path, `refs/heads/${from}`], GIT_WRITE_TIMEOUT_MS);
            if (!created.ok) throw new Error('Could not create worktree');
            scope = realpathSync(planned.value.path);
          });
          repositories.set(repo, provision);
          try { await provision; } finally { if (repositories.get(repo) === provision) repositories.delete(repo); }
        }
        signal?.throwIfAborted();
        occurrence = { ...occurrence, scope }; schedules.saveOccurrence(occurrence);
        try {
          const view = await executions.startScheduled({ occurrenceId: occurrence.id, definition: workflows.getDefinition(occurrence.settings.workflowId), input: occurrence.settings.input, scope, projectId: occurrence.settings.projectId, mcpConnectionIds: occurrence.settings.mcpConnectionIds, attach: attachment(occurrence.id), signal });
          const saved = schedules.getOccurrence(occurrence.id);
          schedules.saveOccurrence(projectExecution(saved, current(saved) ?? view.execution, Date.now()));
        } catch (error) {
          const record = workflows.listExecutions(`occurrence-${occurrence.id}`)[0];
          if (!record) throw error;
          throw new ScheduledExecutionStarted(record.id, { cause: error });
        }
      } finally { provisioning.delete(initial.id); }
    },
    async reconcile(occurrence) {
      // A checkpoint can have reached disk before occurrence metadata. Recover by durable owner,
      // never by re-launching an ambiguous provisioning claim.
      const records = workflows.listExecutions(`occurrence-${occurrence.id}`);
      const record = records[0];
      if (!record) {
        const saved = schedules.getOccurrence(occurrence.id);
        if (isActiveOccurrence(saved)) schedules.saveOccurrence({ ...saved, status: 'interrupted', finishedAt: Date.now(), outcome: 'Session Host stopped during provisioning; this occurrence will not be replayed.' });
        await cleanupUnstarted(saved);
        return;
      }
      const current = executions.scheduler.get(`occurrence-${occurrence.id}`, record.id);
      executions.restoreScheduled(current, occurrence.settings.mcpConnectionIds, attachment(occurrence.id));
      if (!current.sessionId && current.status === 'recovery-required') {
        try { const sessionId = await attachment(occurrence.id)(); executions.scheduler.associate(occurrence.id, current.id, sessionId); current.sessionId = sessionId; }
        catch { schedules.saveOccurrence({ ...schedules.getOccurrence(occurrence.id), executionId: current.id, status: 'recovery-required', outcome: 'Agent Session attachment failed. Restore backend availability and restart the Session Host to reconcile.' }); return; }
      }
      const status = current.status;
      schedules.saveOccurrence({ ...schedules.getOccurrence(occurrence.id), executionId: current.id, ...(current.sessionId ? { sessionId: current.sessionId } : {}), status,
        ...(status === 'running' || status === 'recovery-required' ? {} : { finishedAt: current.finishedAt ?? Date.now() }) });
      if (current.sessionId && status === 'recovery-required') host.workflowWake(current.sessionId, current.id, (await import('../workflows/recovery.ts')).recoveryRevision(current));
    },
    async cancel(occurrence) {
      if (occurrence.executionId) await executions.cancel(`occurrence-${occurrence.id}`, occurrence.executionId);
      const saved = schedules.getOccurrence(occurrence.id);
      if (['provisioning', 'running', 'recovery-required'].includes(saved.status)) schedules.saveOccurrence({ ...saved, status: 'cancelled', finishedAt: Date.now() });
    },
    cleanup: cleanupResources,
    cleanupUnstarted,
  };
}
