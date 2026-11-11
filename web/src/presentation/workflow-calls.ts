import type { WorkflowDefinition, WorkflowExecution, WorkflowStep } from '../../../src/protocol/workflows.ts';

export type WorkflowCallStep = Extract<WorkflowStep, { kind: 'workflow' }>;
export interface WorkflowCatalogue {
  workflows: Array<Pick<WorkflowDefinition, 'id' | 'name' | 'backend' | 'projectId'> & { contract: WorkflowCallStep['contract'] }>;
  errors: Array<{ id: string; name: string; message: string }>;
}

export function selectWorkflowContract(step: WorkflowCallStep, selection: WorkflowCatalogue['workflows'][number]): WorkflowCallStep {
  return { ...step, workflowId: selection.id, contract: structuredClone(selection.contract) };
}

export function invocationTrail(root: WorkflowExecution, invocationId: string): Array<{ id: string; name: string; call: string; attempt: number }> {
  const trail = [];
  const seen = new Set<string>();
  for (let id: string | undefined = invocationId || undefined; id !== undefined;) {
    const invocation = root.invocations?.[id];
    if (!invocation || seen.has(id)) break;
    seen.add(id);
    const parent = invocation.parentInvocationId ? root.invocations?.[invocation.parentInvocationId] : undefined;
    const caller = parent ? root.retainedDefinitions?.[parent.definitionId] : root.definition;
    trail.unshift({ id, name: root.retainedDefinitions?.[invocation.definitionId]?.name ?? invocation.definitionId, call: caller?.steps.find(step => step.id === invocation.callStepId)?.name ?? invocation.callStepId, attempt: invocation.callAttempt });
    id = invocation.parentInvocationId;
  }
  return trail;
}

export function workflowActivityQuery(stepId: string, attempt: number, legacy: boolean, invocationId?: string): string {
  return `stepId=${encodeURIComponent(stepId)}${legacy ? '' : `&attempt=${attempt}`}${invocationId ? `&invocationId=${encodeURIComponent(invocationId)}` : ''}`;
}
