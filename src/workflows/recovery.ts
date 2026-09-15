import { createHash } from 'node:crypto';
import type { WorkflowExecution } from '../protocol/workflows.ts';
import type { RecoverWorkflow } from '../protocol/workflow-executions.ts';

/** State identity, not wall-clock time: repeated notifications cannot mint new authority. */
export function recoveryRevision(record: WorkflowExecution): string {
  return createHash('sha256').update(JSON.stringify({ id: record.id, status: record.status,
    steps: Object.entries(record.steps).map(([id, step]) => [id, step.status, step.attempts.map(a => [a.number, a.action, a.finishedAt, a.error])]),
    loops: record.loops,
  })).digest('hex');
}
export function successfulProgress(record: WorkflowExecution): number {
  return Object.values(record.steps).reduce((count, step) => count + step.attempts.filter(a => a.finishedAt !== undefined && a.output !== undefined && !a.error && a.action !== 'supply').length, 0);
}
export function safeAutomaticRecovery(record: WorkflowExecution, action: RecoverWorkflow): boolean {
  if (record.status !== 'recovery-required' || Object.values(record.loops ?? {}).some(loop => loop.phase === 'limit')) return false;
  if (action.kind === 'retry') {
    // External tools, arbitrary code and agents cannot prove that replay is free of effects.
    const step = record.definition.steps.find(step => step.id === action.stepId);
    return !!step && ['branch', 'join'].includes(step.kind);
  }
  if (action.kind === 'continue') {
    // Continue is safe only for work which has not been attempted, never an implicit replay.
    return Object.values(record.steps).every(step => ['completed', 'skipped'].includes(step.status) || (['pending', 'blocked'].includes(step.status) && !step.attempts.length));
  }
  return false;
}
