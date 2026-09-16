import { boundedMcpValue, validateMcpOutput } from './mcp.ts';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { WorkflowExecution } from '../protocol/workflows.ts';
import { validateDefinition, workflowDefinitionValidator } from './graph.ts';

const errorValidator = z.object({ message: z.string(), kind: z.enum(['failure', 'timeout', 'interrupted']) }).strict();
const identityValidator = z.object({ headerId: z.string().min(1), activation: z.number().int().positive(), try: z.number().int().positive() }).strict();
const loopValidator = z.object({
  activation: z.number().int().nonnegative(), try: z.number().int().nonnegative(),
  phase: z.enum(['inactive', 'active', 'repeating', 'limit', 'exited']), headerInput: z.json().optional(), headerRecovery: z.boolean().optional(),
  grants: z.array(z.object({ activation: z.number().int().positive(), try: z.number().int().positive(), guidance: z.string().max(100_000).optional() }).strict()),
}).strict();
const attemptValidator = z.object({
  loops: z.array(identityValidator).optional(),
  number: z.number().int().positive(), action: z.enum(['execute', 'retry', 'supply']), startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(),
  input: z.json(), output: z.json().optional(), partialOutput: z.json().optional(), error: errorValidator.optional(),
}).strict();

export const workflowExecutionValidator = z.object({
  version: z.literal(1), id: z.string().min(1), sessionId: z.string().min(1), scope: z.string(), definition: workflowDefinitionValidator,
  input: z.json(), launchId: z.string().min(1).optional(), testStepId: z.string().optional(), status: z.enum(['running', 'recovery-required', 'completed', 'completed-with-recovery', 'cancelled']),
  startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(), result: z.json().optional(),
  loops: z.record(z.string(), loopValidator).optional(),
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
  const loops = record.testStepId ? [] : graph.loops;
  if (loops.length !== Object.keys(record.loops ?? {}).length || loops.some(loop => !record.loops?.[loop.headerId])) throw new Error('Execution loops do not match the definition');
  for (const loop of loops) {
    const state = record.loops![loop.headerId]!;
    if ((state.phase === 'inactive' && state.try !== 0) || (state.phase !== 'inactive' && state.phase !== 'exited' && (!state.activation || !state.try))) throw new Error('Invalid loop phase');
    if (state.phase === 'exited' && loop.memberIds.some(id => ['pending', 'running', 'interrupted', 'blocked'].includes(record.steps[id]!.status))) throw new Error('Exited loop contains unfinished work');
    if (state.phase === 'inactive' && loop.memberIds.some(id => !['pending', 'blocked', 'skipped', 'cancelled'].includes(record.steps[id]!.status))) throw new Error('Inactive loop contains active work');
    if (state.phase === 'active' && state.try > 1 && state.headerInput === undefined) throw new Error('Missing repeat header input');
    const grants = new Set<string>();
    for (const grant of state.grants) {
      const key = `${grant.activation}:${grant.try}`;
      if (grants.has(key) || grant.activation > state.activation || grant.try <= loop.maxTries) throw new Error('Invalid loop grant');
      if (grant.try > loop.maxTries + 1 && !grants.has(`${grant.activation}:${grant.try - 1}`)) throw new Error('Invalid loop grant sequence');
      grants.add(key);
    }
    if (state.try > loop.maxTries && !grants.has(`${state.activation}:${state.try}`)) throw new Error('Missing loop grant');
    if (state.phase === 'limit' && (state.try < loop.maxTries || grants.has(`${state.activation}:${state.try + 1}`))) throw new Error('Invalid loop limit');
    if (state.phase === 'limit' && ['completed', 'completed-with-recovery'].includes(record.status)) throw new Error('Completed execution has a loop limit');
  }
  for (const [id, step] of Object.entries(record.steps)) {
    const definition = graph.order.find(candidate => candidate.id === id)!;
    if (definition.kind === 'mcp') {
      if (step.output !== undefined) validateMcpOutput(definition.tool, step.output);
      for (const attempt of step.attempts) {
        if (attempt.output !== undefined) validateMcpOutput(definition.tool, attempt.output);
        if (attempt.partialOutput !== undefined) boundedMcpValue(attempt.partialOutput);
      }
    }
    const containing = loops.filter(loop => loop.memberIds.includes(id));
    for (const [index, attempt] of step.attempts.entries()) {
      if ((attempt.loops ?? []).length !== containing.length || containing.some(loop => !attempt.loops?.some(identity => identity.headerId === loop.headerId))) throw new Error('Invalid attempt loop identities');
      if (containing.length && index === 0 && attempt.action !== 'execute') throw new Error('Invalid initial loop attempt');
      const previous = step.attempts[index - 1];
      if (containing.length && previous) {
        const same = isDeepStrictEqual(previous.loops, attempt.loops);
        if ((attempt.action === 'execute') === same) throw new Error('Invalid attempt action for loop try');
        for (const identity of attempt.loops!) {
          const prior = previous.loops!.find(prior => prior.headerId === identity.headerId)!;
          if (identity.activation < prior.activation || (identity.activation === prior.activation && identity.try < prior.try)) throw new Error('Loop attempt identity moved backwards');
        }
      }
      for (const identity of attempt.loops ?? []) {
        const state = record.loops![identity.headerId]!;
        const loop = loops.find(loop => loop.headerId === identity.headerId)!;
        if (identity.activation > state.activation || (identity.activation === state.activation && state.try > 0 && identity.try > state.try)) throw new Error('Invalid attempt loop identity');
        if (identity.try > loop.maxTries && !state.grants.some(grant => grant.activation === identity.activation && grant.try === identity.try)) throw new Error('Attempt lacks a loop grant');
      }
    }
    if (step.attempts.some((attempt, index) => attempt.number !== index + 1)) throw new Error('Invalid attempt sequence');
    if (['running', 'completed', 'failed', 'timed-out', 'interrupted'].includes(step.status) && !step.attempts.length) throw new Error('Missing step attempt');
    if (step.status === 'completed' && step.output === undefined) throw new Error('Missing completed output');
  }
  if (['completed', 'completed-with-recovery'].includes(record.status) && Object.values(record.steps).some(step => ['pending', 'running', 'interrupted', 'blocked'].includes(step.status))) throw new Error('Completed execution contains unfinished work');
  return record;
}
