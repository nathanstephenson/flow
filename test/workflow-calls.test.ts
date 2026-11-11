import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VisualSchema, WorkflowDefinition, WorkflowExecution, WorkflowInvocation, WorkflowStep } from '../src/protocol/workflows.ts';
import { deriveResultSchema, resolveWorkflowCalls } from '../src/workflows/calls.ts';
import { validateDefinition } from '../src/workflows/graph.ts';
import { parseExecution } from '../src/workflows/records.ts';
import { parseValue } from '../src/workflows/schema.ts';

const empty = { type: 'object', fields: {} } as const;
const leaf = (id: string, outputSchema: VisualSchema = { type: 'number' }): WorkflowStep => ({ id, name: id, kind: 'typescript', code: 'return 1', outputSchema });
const definition = (id: string, steps: WorkflowStep[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition => ({ version: 1, id, name: id, backend: 'fake', inputSchema: empty, steps, edges });
const call = (id: string, target: WorkflowDefinition): Extract<WorkflowStep, { kind: 'workflow' }> => ({ id, name: id, kind: 'workflow', workflowId: target.id, contract: { inputSchema: target.inputSchema, outputSchema: deriveResultSchema(target) } });
const child = () => definition('child', [leaf('inner')]);
const edge = (from: string, to: string, outcome: WorkflowDefinition['edges'][number]['outcome'] = 'success') => ({ id: `${from}-${to}-${outcome}`, from, to, outcome });

function checkpoint(): WorkflowExecution {
  const target = child();
  const root = definition('root', [{ ...call('call', target), timeoutMs: 50 }]);
  const invocation: WorkflowInvocation = { id: 'invocation', callStepId: 'call', callAttempt: 1, definitionId: target.id, input: {}, status: 'completed', startedAt: 2, finishedAt: 4, result: 1,
    steps: { inner: { status: 'completed', attempts: [{ number: 1, action: 'execute', startedAt: 2, finishedAt: 3, input: {}, output: 1 }], output: 1, outcome: 'success' } } };
  return { version: 1, id: 'execution', sessionId: 'session', scope: '/tmp', definition: root, retainedDefinitions: { root, child: target }, invocations: { invocation }, input: {}, status: 'completed', startedAt: 1, finishedAt: 5, result: 1,
    steps: { call: { status: 'completed', attempts: [{ number: 1, action: 'execute', startedAt: 1, deadlineAt: 51, finishedAt: 5, input: {}, output: 1 }], output: 1, outcome: 'success' } } };
}

test('derives scalar, parallel, branch and join terminal contracts', () => {
  assert.deepEqual(deriveResultSchema(child()), { type: 'number' });
  const parallel = deriveResultSchema(definition('parallel', [leaf('a'), leaf('b', { type: 'string' })]));
  assert.deepEqual(parseValue(parallel, { a: 1, b: 'two' }), { a: 1, b: 'two' });
  assert.throws(() => parseValue(parallel, 1));
  assert.throws(() => parseValue(parallel, { a: 1 }));
  const branch: WorkflowStep = { id: 'branch', name: 'branch', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } };
  const selected = definition('selected', [branch, leaf('yes'), leaf('no', { type: 'string' })], [edge('branch', 'yes', 'true'), edge('branch', 'no', 'false')]);
  assert.equal(parseValue(deriveResultSchema(selected), 1), 1);
  assert.equal(parseValue(deriveResultSchema(selected), 'no'), 'no');
  selected.steps.push({ id: 'join', name: 'join', kind: 'join' });
  selected.edges.push(edge('yes', 'join'), edge('no', 'join'));
  assert.deepEqual(parseValue(deriveResultSchema(selected), { yes: 1 }), { yes: 1 });
  assert.equal(parseValue(deriveResultSchema(definition('branch-only', [branch])), true), true);
});

test('result contracts include retained recovery outputs after retry', () => {
  const recovered = definition('recovered', [leaf('work'), leaf('repair', { type: 'string' })], [edge('work', 'repair', 'failure')]);
  const result = { work: 1, repair: 'retained' };
  assert.deepEqual(parseValue(deriveResultSchema(recovered), result), result);
});

test('captures the root and transitive targets once without sharing mutable definitions', () => {
  const bottom = child();
  const middle = definition('middle', [call('deep', bottom)]);
  const root = definition('root', [call('left', middle), call('right', middle)]);
  const reads: string[] = [];
  const manifest = resolveWorkflowCalls(root, id => { reads.push(id); return id === middle.id ? middle : bottom; });
  assert.deepEqual(Object.keys(manifest).sort(), ['child', 'middle', 'root']);
  assert.deepEqual(reads, ['middle', 'child']);
  bottom.name = 'changed';
  assert.equal(manifest.child!.name, 'child');
});

test('rejects missing targets, contract drift and direct or indirect recursion', () => {
  const target = child();
  const root = definition('root', [call('call', target)]);
  assert.throws(() => resolveWorkflowCalls(root, () => { throw new Error('gone'); }), /Missing/);
  assert.throws(() => resolveWorkflowCalls(root, () => definition('wrong', [leaf('inner')])), /Missing/);
  assert.throws(() => resolveWorkflowCalls(root, () => definition('child', [leaf('inner', { type: 'string' })])), /contract/);
  const changed = structuredClone(target);
  changed.inputSchema.fields.extra = { schema: { type: 'string' } };
  assert.throws(() => resolveWorkflowCalls(root, () => changed), /contract/);
  const self = definition('self', [{ ...call('call', target), workflowId: 'self' }]);
  assert.throws(() => resolveWorkflowCalls(self, () => self), /Recursive/);
  const recursive = definition('child', [{ ...call('call', target), workflowId: 'root' }]);
  assert.throws(() => resolveWorkflowCalls(root, () => recursive), /Recursive/);
});

test('compares contracts independent of object key order and accepts implementation edits', () => {
  const target = child();
  target.inputSchema.fields = { a: { schema: { type: 'number' } }, b: { schema: { type: 'string' } } };
  const root = definition('root', [{ ...call('call', target), mapping: { kind: 'template', template: { kind: 'literal', value: {} } } }]);
  const changed = structuredClone(target);
  changed.inputSchema.fields = { b: changed.inputSchema.fields.b!, a: changed.inputSchema.fields.a! };
  (changed.steps[0] as Extract<WorkflowStep, { kind: 'typescript' }>).code = 'return 2';
  assert.equal(resolveWorkflowCalls(root, () => changed).child!.steps[0]!.kind, 'typescript');
});

test('selected-step resolution captures only the selected call subtree', () => {
  const target = child();
  const root = definition('root', [call('selected', target), { ...call('missing', target), workflowId: 'missing' }, leaf('ordinary')]);
  assert.deepEqual(Object.keys(resolveWorkflowCalls(root, () => target, 'selected')).sort(), ['child', 'root']);
  assert.deepEqual(Object.keys(resolveWorkflowCalls(root, () => { throw new Error('must not read'); }, 'ordinary')), ['root']);
  assert.throws(() => resolveWorkflowCalls(root, () => target, 'absent'), /Unknown test step/);
});

test('validates mapped call inputs and makes declared call output available downstream', () => {
  const target = child();
  target.inputSchema = { type: 'object', fields: { value: { schema: { type: 'number' }, required: true } } };
  const root = definition('root', [{ ...call('call', target), mapping: { kind: 'template', template: { kind: 'literal', value: { value: 1 } } } }, { ...leaf('after'), mapping: { kind: 'reference', reference: { source: 'step', stepId: 'call', path: [] } }, inputSchema: { type: 'number' } }], [edge('call', 'after')]);
  validateDefinition(root);
  const invalid = structuredClone(root);
  invalid.steps[0]!.mapping = { kind: 'template', template: { kind: 'literal', value: { value: 'wrong' } } };
  assert.throws(() => validateDefinition(invalid));
});

test('persists flat invocation records and deadlines while accepting old executions', () => {
  const record = checkpoint();
  assert.deepEqual(parseExecution(record), record);
  const old = { ...record, definition: child(), steps: record.invocations!.invocation!.steps };
  delete old.retainedDefinitions;
  delete old.invocations;
  assert.deepEqual(parseExecution(old), old);
});

test('rejects corrupt manifests, ownership, attempts and deadlines', () => {
  const corruptions: Array<(record: WorkflowExecution) => void> = [
    record => { delete record.retainedDefinitions; },
    record => { delete record.retainedDefinitions!.child; },
    record => { record.retainedDefinitions!.wrong = child(); },
    record => { record.retainedDefinitions!.child!.name = 'wrong-key-root'; record.retainedDefinitions!.child!.id = 'other'; },
    record => { record.invocations!.invocation!.id = 'different'; },
    record => { record.invocations!.invocation!.parentInvocationId = 'missing'; },
    record => { record.invocations!.invocation!.parentInvocationId = 'invocation'; },
    record => { record.invocations!.invocation!.callStepId = 'missing'; },
    record => { record.invocations!.invocation!.callAttempt = 2; },
    record => { record.invocations!.invocation!.definitionId = 'root'; },
    record => { record.invocations!.invocation!.input = { wrong: true }; },
    record => { record.invocations!.duplicate = { ...record.invocations!.invocation!, id: 'duplicate' }; },
    record => { record.steps.call!.attempts[0]!.action = 'supply'; },
    record => { record.steps.call!.attempts[0]!.deadlineAt = -1; },
    record => { record.steps.call!.attempts[0]!.deadlineAt = 52; },
    record => { record.invocations!.invocation!.steps = {}; },
  ];
  for (const corrupt of corruptions) {
    const record = checkpoint();
    corrupt(record);
    assert.throws(() => parseExecution(record), corrupt.toString());
  }
  const extra = checkpoint();
  (extra.invocations!.invocation as unknown as Record<string, unknown>).scope = '/other';
  assert.throws(() => parseExecution(extra));
});

test('validates invocation-local correction chains without changing the manifest', () => {
  const record = checkpoint();
  const invocation = record.invocations!.invocation!;
  const previousStep = structuredClone(record.retainedDefinitions!.child!.steps[0]!);
  const nextStep = { ...previousStep, kind: 'typescript' as const, code: 'return 2', outputSchema: { type: 'number' as const } };
  invocation.steps.inner!.attempts[0] = { number: 1, action: 'execute', startedAt: 2, finishedAt: 3, input: {}, error: { message: 'failed', kind: 'failure' } };
  invocation.steps.inner!.attempts.push({ number: 2, action: 'retry', startedAt: 4, finishedAt: 5, input: {}, output: 1 });
  invocation.definitionUpdates = [{ stepId: 'inner', previousStep, nextStep, appliedAt: 4, attempt: 2 }];
  assert.deepEqual(parseExecution(record), record);
  assert.deepEqual(record.retainedDefinitions!.child!.steps[0], previousStep);
  for (const mutate of [
    (value: WorkflowExecution) => { value.invocations!.invocation!.definitionUpdates![0]!.previousStep.name = 'wrong'; },
    (value: WorkflowExecution) => { value.invocations!.invocation!.definitionUpdates![0]!.nextStep.permission = 'auto-accept'; },
    (value: WorkflowExecution) => { value.invocations!.invocation!.definitionUpdates![0]!.attempt = 3; },
  ]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    assert.throws(() => parseExecution(invalid));
  }
});
