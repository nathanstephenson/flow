import { realpathSync } from 'node:fs';
import type { BackendEvent, ModelInfo, Spend } from '../protocol/events.ts';
import type { WorkflowDefinition, WorkflowExecution, WorkflowStep } from '../protocol/workflows.ts';
import { invocationExecution } from '../workflows/invocations.ts';
import { WorkflowStepError, type ExecutorContext } from '../workflows/scheduler.ts';
import { redactCredentials } from './credential-redaction.ts';

export class WorkflowConflict extends Error { constructor() { super('Workflow decision or slot is no longer available'); } }

export function sameProject(project: string, scope: string): boolean {
  try { return realpathSync(project) === scope; } catch { return false; }
}

export function redact<T>(value: T, secrets: string[]): T { return redactCredentials(value, secrets); }

export function redactEvent<T extends BackendEvent | { type: 'spend'; spend: Spend }>(event: T, secrets: string[], publicId: (id: string) => string): T {
  const visit = (item: unknown, path: string[] = []): unknown => {
    if (typeof item === 'string') {
      const key = path.at(-1)!;
      if (path.length === 1 && ['type', 'state', 'on', 'decision', 'reason', 'level', 'trigger', 'effort'].includes(key)) return item;
      if (['id', 'callId', 'askId', 'subagentId', 'turnId'].includes(key) && (path.length === 1 || path[0] === 'producer')) return publicId(item);
      return redact(item, secrets);
    }
    if (Array.isArray(item)) return item.map(value => visit(value, path));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, value]) => [key,
      path.length === 0 && ['input', 'update', 'result'].includes(key) ? redact(value, secrets) : visit(value, [...path, key]),
    ]));
    return item;
  };
  return visit(event) as T;
}

export function confirmedAgentStep(step: Extract<WorkflowStep, { kind: 'agent' }>, models: readonly ModelInfo[]): typeof step {
  const model = models.find(candidate => candidate.id === step.model);
  return model && !model.effortLevels?.length && step.effort !== 'off' ? { ...step, effort: 'off' } : step;
}

export function withConfirmedNoControlOff(definition: WorkflowDefinition, models: readonly ModelInfo[]): WorkflowDefinition {
  const steps = definition.steps.map(step => step.kind === 'agent' ? confirmedAgentStep(step, models) : step);
  return steps.some((step, index) => step !== definition.steps[index]) ? { ...definition, steps } : definition;
}

function publicStep({ secrets, ...step }: WorkflowStep) { return step; }

export function publicDefinition(definition: WorkflowDefinition) {
  return { ...definition, steps: definition.steps.map(publicStep) };
}

export function publicExecutionData(record: WorkflowExecution) {
  const corrections = (updates: WorkflowExecution['definitionUpdates']) => updates?.map(update => ({ ...update, previousStep: publicStep(update.previousStep), nextStep: publicStep(update.nextStep) }));
  return {
    ...record,
    definition: publicDefinition(record.definition),
    definitionUpdates: corrections(record.definitionUpdates),
    retainedDefinitions: record.retainedDefinitions && Object.fromEntries(Object.entries(record.retainedDefinitions).map(([id, definition]) => [id, publicDefinition(definition)])),
    invocations: record.invocations && Object.fromEntries(Object.entries(record.invocations).map(([id, invocation]) => [id, { ...invocation, definitionUpdates: corrections(invocation.definitionUpdates) }])),
  };
}

export function assertNoSecrets(value: unknown, secrets: string[], checkKeys = false): void {
  const visit = (item: unknown): boolean => {
    if (typeof item === 'string') return redact(item, secrets) !== item;
    if (Array.isArray(item)) return item.some(visit);
    return !!item && typeof item === 'object' && Object.entries(item).some(([key, value]) => (checkKeys && visit(key)) || visit(value));
  };
  if (visit(value)) throw new Error('Saved workflow data cannot contain secret values');
}

export function safeError(error: unknown, values: string[]): Error {
  const message = redact(error instanceof Error ? error.message : String(error), values);
  return error instanceof WorkflowStepError ? new WorkflowStepError(message, error.partialOutput === undefined ? undefined : redact(error.partialOutput, values)) : new Error(message);
}

export function outcomeNamingData(record: WorkflowExecution): { results: unknown; errors: unknown } {
  const stepNames = new Map(record.definition.steps.map(step => [step.id, step.name]));
  function* results() {
    for (const id in record.steps) {
      const output = record.steps[id]!.output;
      if (output !== undefined) yield { step: stepNames.get(id) ?? id, output };
    }
  }
  function* errors() {
    for (const id in record.steps) for (const attempt of record.steps[id]!.attempts) {
      if (attempt.error !== undefined) yield {
        step: stepNames.get(id) ?? id, attempt: attempt.number, error: attempt.error,
        ...(attempt.partialOutput === undefined ? {} : { partialOutput: attempt.partialOutput }),
      };
    }
  }
  return { results: record.result === undefined ? results() : record.result, errors: errors() };
}

export function uniqueCredentials(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }

export function relayContext(record: WorkflowExecution, stepId: string, attempt: number, invocationId?: string): string {
  const step = record.definition.steps.find(item => item.id === stepId);
  return `Workflow “${record.definition.name}” · Step “${step?.name ?? stepId}” · Attempt ${attempt}${invocationId ? ` · Invocation ${invocationId}` : ''}${record.testStepId ? ' · Step test' : ''}`;
}

export function relaySignal(request: AbortSignal, parent?: AbortSignal): AbortSignal { return parent ? AbortSignal.any([request, parent]) : request; }

export function selectWorkflowInvocation(root: WorkflowExecution, invocationId?: string): WorkflowExecution {
  return invocationId === undefined ? root : { ...invocationExecution(root, invocationId), id: root.id };
}

export function attemptIdentity(context: ExecutorContext): { stepId: string; attempt: number; invocationId?: string } {
  return { stepId: context.step.id, attempt: context.attempt ?? 1, ...(context.invocationId === undefined ? {} : { invocationId: context.invocationId }) };
}

export function spendKey(stepId: string, invocationId?: string): string { return invocationId === undefined ? stepId : JSON.stringify([invocationId, stepId]); }

export function sumSpend(values: Spend[]): Spend {
  const result: Spend = { tokens: 0, cached: 0, costUSD: 0, models: [] };
  for (const value of values) {
    result.tokens += value.tokens; result.cached += value.cached; result.costUSD += value.costUSD;
    for (const model of value.models) {
      const existing = result.models.find(item => item.id === model.id);
      if (existing) { existing.tokens += model.tokens; existing.cached += model.cached; existing.costUSD += model.costUSD; }
      else result.models.push({ ...model });
    }
  }
  return result;
}
