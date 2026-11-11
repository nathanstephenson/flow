import type { VisualSchema, WorkflowDefinition } from '../protocol/workflows.ts';
import { validateDefinition } from './graph.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
  return value;
}

export function deriveResultSchema(definition: WorkflowDefinition): VisualSchema {
  return validateDefinition(definition).resultSchema;
}

export function resolveWorkflowCalls(definition: WorkflowDefinition, lookup: (id: string) => WorkflowDefinition, testStepId?: string): Record<string, WorkflowDefinition> {
  const retained: Record<string, WorkflowDefinition> = {};
  const visited = new Set<string>();
  const visit = (candidate: WorkflowDefinition, ancestry: Set<string>, selected?: string): void => {
    if (ancestry.has(candidate.id)) throw new Error(`Recursive Workflow call: ${candidate.id}`);
    const graph = validateDefinition(candidate);
    const current = graph.definition;
    if (selected !== undefined && !current.steps.some(step => step.id === selected)) throw new Error('Unknown test step');
    retained[current.id] = current;
    const path = new Set([...ancestry, current.id]);
    for (const step of current.steps) {
      if (step.kind !== 'workflow' || (selected !== undefined && step.id !== selected)) continue;
      if (path.has(step.workflowId)) throw new Error(`Recursive Workflow call: ${step.workflowId}`);
      let target = Object.hasOwn(retained, step.workflowId) ? retained[step.workflowId] : undefined;
      if (!target) {
        try { target = lookup(step.workflowId); }
        catch { throw new Error(`Missing Workflow call target: ${step.workflowId}`); }
      }
      if (!target || target.id !== step.workflowId) throw new Error(`Missing Workflow call target: ${step.workflowId}`);
      const called = validateDefinition(target);
      if (JSON.stringify(canonical(step.contract.inputSchema)) !== JSON.stringify(canonical(called.definition.inputSchema)) || JSON.stringify(canonical(step.contract.outputSchema)) !== JSON.stringify(canonical(called.resultSchema))) throw new Error(`Workflow call contract does not match target: ${step.workflowId}`);
      if (!visited.has(target.id)) visit(called.definition, path);
    }
    visited.add(current.id);
  };
  visit(definition, new Set(), testStepId);
  return retained;
}
