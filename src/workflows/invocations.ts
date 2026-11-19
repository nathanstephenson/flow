import type { WorkflowExecution, WorkflowInvocation } from '../protocol/workflows.ts';
import { executionIdentity } from './owner.ts';

export function invocationExecution(root: WorkflowExecution, invocationId: string): WorkflowExecution {
  const invocation = root.invocations?.[invocationId];
  if (!invocation) throw new Error('Unknown workflow invocation');
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
