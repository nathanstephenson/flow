import { join } from 'node:path';
import { removeOwnedSandbox, sandboxUnavailable } from '../isolation/sandbox.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type { WorkflowOccurrence, WorkflowScheduleSettings } from '../protocol/workflow-schedules.ts';
import { projectExecution } from '../workflows/schedules.ts';
import { ScheduledExecutionStarted, type ScheduleDriver } from './workflow-schedules.ts';
import type { WorkflowExecutionService } from './workflow-executions.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import type { WorkflowScheduleStore } from '../workflows/schedule-store.ts';
import type { TranscriptStore } from './store.ts';
import type { SessionHost } from './host.ts';
import type { ConfigStore } from './config-store.ts';
import { resolveWorkflowCalls } from '../workflows/calls.ts';
import { parseValue } from '../workflows/schema.ts';
import { includedProjects } from './projects.ts';
import { isClean, localBranches, planWorktree, removeMergedBranch, removeWorktree, run, GIT_WRITE_TIMEOUT_MS } from './git.ts';

export function scheduleDriver(options: { host: SessionHost; config: ConfigStore; workflows: WorkflowStore; executions: WorkflowExecutionService; schedules: WorkflowScheduleStore; transcripts: TranscriptStore }): ScheduleDriver {
  const { host, config, workflows, executions, schedules, transcripts } = options;
  const repositories = new Map<string, Promise<unknown>>();
  function current(occurrence: WorkflowOccurrence) {
    const owner = `occurrence-${occurrence.id}`;
    return occurrence.executionId ? workflows.getExecution(owner, occurrence.executionId) : workflows.listExecutions(owner)[0];
  }
  async function validate(settings: WorkflowScheduleSettings): Promise<void> {
    const projects = includedProjects(config.rawProjectRoot(), config.projectInclude());
    const project = projects.find(project => project.path === settings.projectId && !project.missing);
    if (!project || realpathSync(project.path) !== settings.projectId) throw new Error('Select an available opted-in Project');
    host.scheduledConnections(settings.mcpConnectionIds);
    const definition = workflows.getDefinition(settings.workflowId);
    const manifest = resolveWorkflowCalls(definition, id => workflows.getDefinition(id));
    parseValue(definition.inputSchema, settings.input);
    executions.validateScheduledInputs(definition, settings.input);
    for (const candidate of Object.values(manifest)) {
      executions.validateDefinitionCredentials(candidate);
      if (candidate.projectId && realpathSync(candidate.projectId) !== settings.projectId) throw new Error('Workflow is restricted to another Project');
      for (const step of candidate.steps) if (step.kind === 'mcp' && !settings.mcpConnectionIds.includes(step.tool.connectionId)) throw new Error('Workflow MCP connection must be selected');
    }
    if (settings.worktree) {
      const branches = await localBranches(settings.projectId);
      if (!branches.ok || !branches.value.includes(settings.worktree.from)) throw new Error('Select an existing local base branch');
    }
  }
  async function reclaimEnvironment(occurrence: WorkflowOccurrence): Promise<void> {
    const path = join(workflows.ownerPath(`occurrence-${occurrence.id}`), 'sandbox.json');
    if (!existsSync(path)) return;
    const support = host.sandboxSupport();
    if (!support?.supported) throw sandboxUnavailable();
    await removeOwnedSandbox(support.provider, path, `flow-occurrence-${occurrence.id}`);
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
        scheduled: { id: sessionId, occurrenceId: id, isolationMode: executions.scheduledIsolation(id), ...(occurrence.worktree ? { worktree: occurrence.worktree } : {}) } });
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
    },
    async reconcile(occurrence) {
      // A checkpoint can have reached disk before occurrence metadata. Recover by durable owner,
      // never by re-launching an ambiguous provisioning claim.
      const records = workflows.listExecutions(`occurrence-${occurrence.id}`);
      const record = records[0];
      if (!record) {
        await reclaimEnvironment(occurrence);
        schedules.saveOccurrence({ ...occurrence, status: 'interrupted', finishedAt: Date.now(), outcome: 'Session Host stopped during provisioning; this occurrence will not be replayed.' }); return;
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
    async cleanup(occurrence) {
      await executions.expireScheduled(occurrence.id);
      await reclaimEnvironment(occurrence);
      // Session metadata, not a path or an intended ID, is the authority for transferred ownership.
      const session = occurrence.sessionId ? transcripts.readMeta(occurrence.sessionId) : undefined;
      if (occurrence.worktree && session?.scheduledOccurrenceId !== occurrence.id) {
        const worktree = occurrence.worktree;
        if (existsSync(worktree.path)) {
          const clean = await isClean(worktree.path);
          const branch = await run(worktree.path, ['symbolic-ref', '--quiet', 'HEAD'], 10_000);
          const head = await run(worktree.path, ['rev-parse', 'HEAD'], 10_000);
          const merged = head.ok ? await run(worktree.repo, ['merge-base', '--is-ancestor', head.value.trim(), 'HEAD'], 10_000) : head;
          if (!clean.ok || !clean.value || !branch.ok || branch.value.trim() !== `refs/heads/${worktree.branch}` || !merged.ok) schedules.saveCleanupWarning(occurrence, 'Worktree preserved: dirty, detached, changed branch, unmerged or unavailable. Manual review required.');
          else {
            const removed = await removeWorktree(worktree);
            if (!removed.ok) schedules.saveCleanupWarning(occurrence, 'Worktree cleanup failed. Manual review required.');
            else {
              const branch = await removeMergedBranch(worktree.repo, worktree.branch);
              if (!branch.ok) schedules.saveCleanupWarning(occurrence, 'Branch cleanup failed. Ref preserved for manual review.');
            }
          }
        } else {
          const branch = await removeMergedBranch(worktree.repo, worktree.branch);
          if (!branch.ok) schedules.saveCleanupWarning(occurrence, 'Worktree absent; branch preserved for manual review.');
        }
      }
      workflows.deleteOwner({ kind: 'occurrence', occurrenceId: occurrence.id });
    },
  };
}
