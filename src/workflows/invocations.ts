import type { WorkflowExecution, WorkflowInvocation } from '../protocol/workflows.ts';
import { executionIdentity } from './owner.ts';

export class WorkflowInvocationNotFound extends Error {}

export function invocationExecution(root: WorkflowExecution, invocationId: string): WorkflowExecution {
  if (!root.invocations || !Object.hasOwn(root.invocations, invocationId)) throw new WorkflowInvocationNotFound('Unknown workflow invocation');
  const invocation = root.invocations[invocationId]!;
  const retained = root.retainedDefinitions?.[invocation.definitionId];
  if (!retained) throw new Error('Missing retained Workflow Definition');
  const definition = structuredClone(retained);
  for (const correction of invocation.definitionUpdates ?? []) {
    const index = definition.steps.findIndex(step => step.id === correction.stepId);
    if (index < 0) throw new Error('Invalid invocation correction');
    definition.steps[index] = structuredClone(correction.nextStep);
  }
  return { ...structuredClone(invocation), ...executionIdentity(root), scope: root.scope, definition };
}

export function invocationCheckpoint(record: WorkflowExecution, ownership: Pick<WorkflowInvocation, 'parentInvocationId' | 'callStepId' | 'callAttempt' | 'definitionId'>): WorkflowInvocation {
  const { version: _, occurrenceId: _occurrence, runtime: _runtime, sessionId: __, scope: ___, definition: ____, ...state } = record;
  return { ...state, ...ownership };
}
