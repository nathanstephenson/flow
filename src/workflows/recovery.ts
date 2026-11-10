import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WorkflowDefinition, WorkflowExecution, WorkflowStep } from '../protocol/workflows.ts';
import { validateDefinition, type WorkflowGraph } from './graph.ts';
import type { RecoverWorkflow } from '../protocol/workflow-executions.ts';

// Object key order is not part of a saved definition's identity; array order is.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
  return value;
}

/** Authority over exactly the saved definition resolved by the host. Not recoveryRevision. */
export function savedDefinitionRevision(definition: WorkflowDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex');
}

function fixedStep(step: WorkflowStep): unknown {
  // An allowlist keeps future contracts and policy fields immutable by default.
  const configurable = new Set<string>(['timeoutMs', 'secrets']);
  if (step.kind === 'agent') ['instructions', 'model', 'effort'].forEach(key => configurable.add(key));
  if (step.kind === 'shell') ['command', 'acceptedExitCodes'].forEach(key => configurable.add(key));
  if (step.kind === 'typescript') configurable.add('code');
  if (step.kind === 'branch') configurable.add('condition');
  // MCP tool snapshots include identity and schemas, so they remain fixed.
  return Object.fromEntries(Object.entries(step).filter(([key]) => !configurable.has(key)));
}

/**
 * Pure host preflight: validate the candidate and allow executable config edits only on stepId.
 * Eligibility, runtime readiness and saved-definition authority are checked by recover itself.
 * Names, positions, permissions, contracts, mappings, tool snapshots and topology stay fixed.
 */
export function validateCompatibleDefinition(previous: WorkflowDefinition, candidate: WorkflowDefinition, stepId: string): WorkflowGraph {
  const graph = validateDefinition(candidate);
  const old = validateDefinition(previous).definition;
  const target = old.steps.find(step => step.id === stepId);
  const next = graph.definition.steps.find(step => step.id === stepId);
  if (!target || !next) throw new Error('Unknown recovery step');
  if (!isDeepStrictEqual(fixedStep(target), fixedStep(next))) throw new Error('Updated definition changes the recovery step contract or policy');
  const { steps: oldSteps, ...oldRest } = old;
  const { steps: nextSteps, ...nextRest } = graph.definition;
  if (!isDeepStrictEqual(oldRest, nextRest) || !isDeepStrictEqual(oldSteps.map(step => step.id === stepId ? fixedStep(step) : step), nextSteps.map(step => step.id === stepId ? fixedStep(step) : step))) {
    throw new Error('Updated definition may change only the recovery step executable configuration');
  }
  return graph;
}

/** State identity, not wall-clock time: repeated notifications cannot mint new authority. */
export function recoveryRevision(record: WorkflowExecution): string {
  return createHash('sha256').update(JSON.stringify({ id: record.id, status: record.status,
    steps: Object.entries(record.steps).map(([id, step]) => [id, step.status, step.attempts.map(a => [a.number, a.action, a.finishedAt, a.error])]),
    loops: record.loops, definition: savedDefinitionRevision(record.definition), definitionUpdates: record.definitionUpdates,
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
