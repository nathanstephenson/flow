import { boundedMcpValue, validateMcpOutput } from './mcp.ts';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { WorkflowDefinition, WorkflowExecution, WorkflowInvocation } from '../protocol/workflows.ts';
import { resolveWorkflowCalls } from './calls.ts';
import { dictionaryRecord } from './schema.ts';
import { validateDefinition, workflowDefinitionValidator } from './graph.ts';
import { validateCompatibleDefinition } from './recovery.ts';

const errorValidator = z.object({ message: z.string(), kind: z.enum(['failure', 'timeout', 'interrupted']) }).strict();
const identityValidator = z.object({ headerId: z.string().min(1), activation: z.number().int().positive(), try: z.number().int().positive() }).strict();
const loopValidator = z.object({
  activation: z.number().int().nonnegative(), try: z.number().int().nonnegative(),
  phase: z.enum(['inactive', 'active', 'repeating', 'limit', 'exited']), headerInput: z.json().optional(), headerRecovery: z.boolean().optional(),
  grants: z.array(z.object({ activation: z.number().int().positive(), try: z.number().int().positive(), guidance: z.string().max(100_000).optional() }).strict()),
}).strict();
const attemptValidator = z.object({
  loops: z.array(identityValidator).optional(),
  number: z.number().int().positive(), action: z.enum(['execute', 'retry', 'supply']), startedAt: z.number().nonnegative(), deadlineAt: z.number().nonnegative().optional(), finishedAt: z.number().nonnegative().optional(),
  input: z.json(), output: z.json().optional(), partialOutput: z.json().optional(), error: errorValidator.optional(),
}).strict();

const checkpointFields = {
  definitionUpdates: z.array(z.object({
    stepId: z.string().min(1), previousStep: workflowDefinitionValidator.shape.steps.element, nextStep: workflowDefinitionValidator.shape.steps.element,
    appliedAt: z.number().nonnegative(), attempt: z.number().int().min(2),
  }).strict()).optional(),
  input: z.json(), status: z.enum(['running', 'recovery-required', 'completed', 'completed-with-recovery', 'cancelled']),
  startedAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(), result: z.json().optional(),
  loops: dictionaryRecord(loopValidator).optional(),
  steps: dictionaryRecord(z.object({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'timed-out', 'interrupted', 'skipped', 'blocked', 'cancelled']), recovery: z.boolean().optional(),
    attempts: z.array(attemptValidator), output: z.json().optional(), outcome: z.enum(['success', 'failure', 'timeout', 'true', 'false']).optional(),
  }).strict()),
};
const invocationValidator = z.object({
  ...checkpointFields, id: z.string().min(1), parentInvocationId: z.string().min(1).optional(),
  callStepId: z.string().min(1), callAttempt: z.number().int().positive(), definitionId: z.string().min(1),
}).strict();
export const workflowExecutionValidator = z.object({
  ...checkpointFields, version: z.literal(1), id: z.string().min(1), sessionId: z.string().min(1), scope: z.string(), definition: workflowDefinitionValidator,
  retainedDefinitions: dictionaryRecord(workflowDefinitionValidator).optional(), invocations: dictionaryRecord(invocationValidator).optional(),
  launchId: z.string().min(1).optional(), naming: z.enum(['pending', 'requested']).optional(), testStepId: z.string().optional(),
}).strict();

function validateCheckpoint(record: WorkflowExecution): WorkflowDefinition {
  const graph = validateDefinition(record.definition);
  if (graph.order.length !== Object.keys(record.steps).length || graph.order.some(step => !Object.hasOwn(record.steps, step.id))) throw new Error('Execution steps do not match the definition');
  // Walk corrections backwards to validate both their contracts and the snapshot chain.
  // The checkpoint before pump may name the next attempt before it has been appended.
  let definition = record.definition;
  const nextAttempts = new Map<string, number>();
  for (const update of [...(record.definitionUpdates ?? [])].reverse()) {
    const state = record.steps[update.stepId];
    const next = definition.steps.find(step => step.id === update.stepId);
    if (!state || update.previousStep.id !== update.stepId || !isDeepStrictEqual(next, update.nextStep)) throw new Error('Invalid definition update snapshot');
    if (update.attempt > state.attempts.length + 1 || (nextAttempts.has(update.stepId) && update.attempt > nextAttempts.get(update.stepId)!)) throw new Error('Invalid definition update attempt');
    const attempt = state.attempts[update.attempt - 1];
    if ((attempt && attempt.action !== 'retry') || !state.attempts[update.attempt - 2]?.error) throw new Error('Definition update requires a failed retry attempt');
    nextAttempts.set(update.stepId, update.attempt);
    const previous = { ...definition, steps: definition.steps.map(step => step.id === update.stepId ? update.previousStep : step) };
    validateCompatibleDefinition(previous, definition, update.stepId);
    definition = previous;
  }
  const original = definition;
  if (record.testStepId && !Object.hasOwn(record.steps, record.testStepId)) throw new Error('Unknown test step');
  if (record.testStepId && record.naming) throw new Error('Step tests cannot name Agent Sessions');
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
      if (attempt.deadlineAt !== undefined) {
        const configuration = stepConfiguration(record, original, id, attempt.number);
        if (configuration?.kind !== 'workflow' || configuration.timeoutMs === undefined || attempt.deadlineAt !== attempt.startedAt + configuration.timeoutMs) throw new Error('Invalid call attempt deadline');
      }
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
  return original;
}

function stepConfiguration(record: WorkflowExecution, original: WorkflowDefinition, stepId: string, attempt: number) {
  let step = original.steps.find(step => step.id === stepId);
  for (const update of record.definitionUpdates ?? []) if (update.stepId === stepId && update.attempt <= attempt) step = update.nextStep;
  return step;
}

export function parseExecution(value: unknown): WorkflowExecution {
  const record = workflowExecutionValidator.parse(value) as WorkflowExecution;
  const original = validateCheckpoint(record);
  const manifest = record.retainedDefinitions;
  if (!manifest) {
    if (record.invocations || record.definition.steps.some(step => step.kind === 'workflow')) throw new Error('Missing retained Workflow Definitions');
    return record;
  }
  for (const [id, definition] of Object.entries(manifest)) if (id !== definition.id) throw new Error('Invalid retained definition identity');
  if (!isDeepStrictEqual(manifest[original.id], original)) throw new Error('Retained root definition does not match the original checkpoint');
  const resolved = resolveWorkflowCalls(original, id => {
    if (!Object.hasOwn(manifest, id)) throw new Error('Missing retained definition');
    return manifest[id]!;
  }, record.testStepId);
  if (!isDeepStrictEqual(resolved, manifest)) throw new Error('Retained definitions do not match the call manifest');
  const locals = new Map<string, WorkflowExecution>();
  const originals = new Map<string, WorkflowDefinition>();
  for (const [id, invocation] of Object.entries(record.invocations ?? {})) {
    if (id !== invocation.id || id === record.id) throw new Error('Invalid invocation identity');
    const retained = manifest[invocation.definitionId];
    if (!retained) throw new Error('Missing invocation definition');
    const definition = structuredClone(retained);
    for (const update of invocation.definitionUpdates ?? []) {
      const index = definition.steps.findIndex(step => step.id === update.stepId);
      if (index < 0) throw new Error('Unknown invocation correction step');
      definition.steps[index] = structuredClone(update.nextStep);
    }
    const local: WorkflowExecution = { ...invocation, version: 1, sessionId: record.sessionId, scope: record.scope, definition };
    if (!isDeepStrictEqual(validateCheckpoint(local), retained)) throw new Error('Invocation corrections do not match the retained definition');
    locals.set(id, local);
    originals.set(id, retained);
  }
  const checked = new Set<string>();
  for (const id of locals.keys()) {
    const path = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !checked.has(current)) {
      if (path.has(current)) throw new Error('Invocation parent cycle');
      path.add(current);
      const invocation: WorkflowInvocation | undefined = record.invocations![current];
      if (!invocation) throw new Error('Missing parent invocation');
      current = invocation.parentInvocationId;
    }
    for (const ancestor of path) checked.add(ancestor);
  }
  const owners = new Set<string>();
  for (const [id, invocation] of Object.entries(record.invocations ?? {})) {
    const parentId = invocation.parentInvocationId;
    const parent = parentId === undefined ? record : locals.get(parentId)!;
    const parentOriginal = parentId === undefined ? original : originals.get(parentId)!;
    const step = stepConfiguration(parent, parentOriginal, invocation.callStepId, invocation.callAttempt);
    const state = parent.steps[invocation.callStepId];
    const attempt = state?.attempts[invocation.callAttempt - 1];
    if (step?.kind !== 'workflow' || step.workflowId !== invocation.definitionId || !attempt || attempt.action === 'supply' || (parent.testStepId !== undefined && parent.testStepId !== step.id)) throw new Error('Invalid invocation call ownership');
    if (!isDeepStrictEqual(invocation.input, attempt.input)) throw new Error('Invocation input does not match the call attempt');
    if (step.timeoutMs !== undefined && attempt.deadlineAt === undefined) throw new Error('Missing call attempt deadline');
    if (invocation.callAttempt < state!.attempts.length && ['running', 'recovery-required'].includes(invocation.status)) throw new Error('Unfinished invocation belongs to an earlier call attempt');
    const owner = JSON.stringify([parentId ?? null, invocation.callStepId, invocation.callAttempt]);
    if (owners.has(owner)) throw new Error('Duplicate invocation call ownership');
    owners.add(owner);
    if (['completed', 'completed-with-recovery'].includes(invocation.status) && invocation.result === undefined) throw new Error('Missing completed invocation result');
    if (['completed', 'completed-with-recovery'].includes(record.status) && ['running', 'recovery-required'].includes(invocation.status)) throw new Error('Completed execution contains unfinished invocations');
    if (!locals.has(id)) throw new Error('Missing invocation checkpoint');
  }
  return record;
}
