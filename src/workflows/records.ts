import { z } from 'zod';
import type { WorkflowExecution } from '../protocol/workflows.ts';
import { validateDefinition, workflowDefinitionValidator } from './graph.ts';

const errorValidator = z.object({ message: z.string(), kind: z.enum(['failure', 'timeout', 'interrupted']) }).strict();
const attemptValidator = z.object({
  number: z.number().int().positive(), action: z.enum(['execute', 'retry', 'supply']), startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(),
  input: z.json(), output: z.json().optional(), partialOutput: z.json().optional(), error: errorValidator.optional(),
}).strict();

export const workflowExecutionValidator = z.object({
  version: z.literal(1), id: z.string().min(1), sessionId: z.string().min(1), scope: z.string(), definition: workflowDefinitionValidator,
  input: z.json(), testStepId: z.string().optional(), status: z.enum(['running', 'recovery-required', 'completed', 'completed-with-recovery', 'cancelled']),
  startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(), result: z.json().optional(),
  steps: z.record(z.string(), z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'timed-out', 'interrupted', 'skipped', 'blocked', 'cancelled']), recovery: z.boolean().optional(),
    attempts: z.array(attemptValidator), output: z.json().optional(), outcome: z.enum(['success', 'failure', 'timeout', 'true', 'false']).optional(),
  }).strict()),
}).strict();

export function parseExecution(value: unknown): WorkflowExecution {
  const record = workflowExecutionValidator.parse(value) as WorkflowExecution;
  const graph = validateDefinition(record.definition);
  if (graph.order.length !== Object.keys(record.steps).length || graph.order.some(step => !Object.hasOwn(record.steps, step.id))) throw new Error('Execution steps do not match the definition');
  if (record.testStepId && !Object.hasOwn(record.steps, record.testStepId)) throw new Error('Unknown test step');
  for (const step of Object.values(record.steps)) {
    if (step.attempts.some((attempt, index) => attempt.number !== index + 1)) throw new Error('Invalid attempt sequence');
    if (['running', 'completed', 'failed', 'timed-out', 'interrupted'].includes(step.status) && !step.attempts.length) throw new Error('Missing step attempt');
    if (step.status === 'completed' && step.output === undefined) throw new Error('Missing completed output');
  }
  return record;
}
