import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowDefinition, WorkflowExecution, WorkflowInvocation } from '../../../src/protocol/workflows.ts';
import { mappingSourceGraph, validateDefinition } from '../../../src/workflows/graph.ts';
import { mappingChoices } from './workflows.ts';
import { invocationTrail, selectWorkflowContract, workflowActivityQuery, type WorkflowCallStep } from './workflow-calls.ts';

const mappedCallDefinition: WorkflowDefinition = {
  version: 1, id: 'parent', name: 'Parent', backend: 'pi',
  inputSchema: { type: 'object', fields: { prompt: { schema: { type: 'string' }, required: true } } },
  steps: [{
    id: 'call', name: 'Call', kind: 'workflow', workflowId: 'child',
    contract: {
      inputSchema: { type: 'object', fields: { question: { schema: { type: 'string' }, required: true } } },
      outputSchema: { type: 'object', fields: { answer: { schema: { type: 'number' }, required: true } } },
    },
    mapping: { kind: 'object', fields: { question: { source: 'input', path: ['prompt'] } } },
  }],
  edges: [],
};

test('call object mapping sources remain available when the required target is not value', () => {
  validateDefinition(mappedCallDefinition);
  assert.deepEqual(mappingChoices(mappedCallDefinition, 'call', 'object').map(choice => choice.label), [
    'Workflow input', 'Workflow input.prompt',
  ]);
});

test('call sources support missing, incomplete and renamed required mappings without changing definitions', () => {
  for (const state of ['missing', 'incomplete', 'renamed']) {
    const definition = structuredClone(mappedCallDefinition);
    const call = definition.steps[0]!;
    assert.ok(call.kind === 'workflow');
    if (state === 'missing') delete call.mapping;
    else {
      assert.ok(call.contract.inputSchema.type === 'object');
      const fields = call.contract.inputSchema.fields;
      call.contract.inputSchema = {
        type: 'object', fields: {
          ...(state === 'incomplete' ? fields : {}),
          context: { schema: { type: 'string' }, required: true },
        },
      };
    }
    const before = structuredClone(definition);
    assert.throws(() => validateDefinition(definition), /call input contract/);
    assert.ok(mappingChoices(definition, 'call', 'object').some(choice => choice.label === 'Workflow input.prompt'), state);
    assert.deepEqual(definition, before);
    assert.throws(() => validateDefinition(definition), /call input contract/);
  }
});

test('call source discovery retains required references and optional object fields', () => {
  const definition = structuredClone(mappedCallDefinition);
  assert.ok(definition.inputSchema.type === 'object');
  definition.inputSchema.fields.optional = { schema: { type: 'string' } };
  definition.inputSchema.fields.payload = {
    required: true, schema: { type: 'object', fields: { question: { required: true, schema: { type: 'string' } } } },
  };
  const before = structuredClone(definition);
  const references = mappingChoices(definition, 'call').map(choice => choice.label);
  const fields = mappingChoices(definition, 'call', 'object').map(choice => choice.label);
  assert.ok(references.includes('Workflow input.payload'));
  assert.ok(!references.includes('Workflow input.optional'));
  assert.ok(fields.includes('Workflow input.optional'));
  assert.deepEqual(definition, before);
  validateDefinition(definition);
});

test('downstream choices use call output contracts even when call mappings need repair', () => {
  for (const invalid of [false, true]) {
    const definition = structuredClone(mappedCallDefinition);
    if (invalid) definition.steps[0]!.mapping = {
      kind: 'reference', reference: { source: 'step', stepId: 'missing', path: [] },
    };
    definition.steps.push(
      { id: 'after', name: 'After', kind: 'typescript', code: '', outputSchema: { type: 'string' } },
      { id: 'future', name: 'Future', kind: 'typescript', code: '', outputSchema: { type: 'string' } },
    );
    definition.edges = [
      { id: 'after', from: 'call', to: 'after', outcome: 'success' },
      { id: 'future', from: 'after', to: 'future', outcome: 'success' },
    ];
    const before = structuredClone(definition);
    const choices = mappingChoices(definition, 'after', 'object');
    assert.deepEqual(choices.filter(choice => choice.reference.source === 'step').map(choice => choice.label), [
      'Call', 'Call.answer',
    ]);
    assert.deepEqual(definition, before);
  }
});

function callRecoveryDefinition(): WorkflowDefinition {
  const definition = structuredClone(mappedCallDefinition);
  definition.steps.push(
    { id: 'recover', name: 'Recover', kind: 'join' },
    { id: 'after', name: 'After', kind: 'typescript', code: '', outputSchema: { type: 'string' } },
  );
  definition.edges = [
    { id: 'recover', from: 'call', to: 'recover', outcome: 'failure' },
    { id: 'after', from: 'recover', to: 'after', outcome: 'success' },
  ];
  return definition;
}

test('recovery mapping sources retain defaulted call inputs while mappings need repair', () => {
  for (const state of ['valid', 'incomplete', 'invalid-reference']) {
    const definition = callRecoveryDefinition();
    const call = definition.steps[0]!;
    assert.ok(call.kind === 'workflow' && call.contract.inputSchema.type === 'object');
    call.contract.inputSchema.fields.context = { schema: { type: 'string' }, required: true, default: 'retained' };
    if (state === 'incomplete') call.mapping = { kind: 'object', fields: {} };
    if (state === 'invalid-reference') call.mapping = { kind: 'reference', reference: { source: 'step', stepId: 'missing', path: [] } };
    const before = structuredClone(definition);
    if (state === 'valid') validateDefinition(definition);
    else assert.throws(() => validateDefinition(definition));
    const choices = mappingChoices(definition, 'after', 'object');
    assert.ok(choices.some(choice => choice.label === 'Recover.Call.input.context'), state);
    assert.ok(choices.some(choice => choice.label === 'Recover.Call.input.question'), state);
    assert.ok(choices.some(choice => choice.label === 'Recover.Call.partialOutput.answer'), state);
    assert.deepEqual(definition, before);
    if (state === 'valid') validateDefinition(definition);
    else assert.throws(() => validateDefinition(definition));
  }
});

test('recovery mapping sources retain nested template call inputs, including incomplete literals', () => {
  for (const kind of ['object', 'literal'] as const) {
    for (const complete of [true, false]) {
      const definition = callRecoveryDefinition();
      const call = definition.steps[0]!;
      assert.ok(call.kind === 'workflow' && call.contract.inputSchema.type === 'object');
      call.contract.inputSchema.fields.context = {
        required: true, schema: { type: 'object', fields: { directory: { schema: { type: 'string' }, required: true } } },
      };
      call.mapping = { kind: 'template', template: kind === 'literal'
        ? { kind: 'literal', value: complete ? { question: 'question', context: { directory: '/tmp' } } : { question: 'question' } }
        : { kind: 'object', fields: {
          question: { kind: 'reference', reference: { source: 'input', path: ['prompt'] } },
          ...(complete ? { context: { kind: 'literal' as const, value: { directory: '/tmp' } } } : {}),
        } },
      };
      const before = structuredClone(definition);
      if (complete) validateDefinition(definition);
      else assert.throws(() => validateDefinition(definition));
      const choices = mappingChoices(definition, 'after', 'object');
      assert.deepEqual(choices.find(choice => choice.label === 'Recover.Call.input.context.directory')?.reference,
        { source: 'step', stepId: 'recover', path: ['Call', 'input', 'context', 'directory'] });
      assert.ok(choices.some(choice => choice.label === 'Recover.Call.input.question'));
      assert.deepEqual(definition, before);
      if (complete) validateDefinition(definition);
      else assert.throws(() => validateDefinition(definition));
    }
  }
});

test('mapping source graphs retain reference, loop, schema and non-call input validation', () => {
  const invalidDefinitions: Array<(definition: WorkflowDefinition) => void> = [
    definition => { definition.steps[0]!.mapping = { kind: 'reference', reference: { source: 'step', stepId: 'after', path: [] } }; },
    definition => { definition.steps[0]!.mapping = { kind: 'template', template: { kind: 'reference', reference: { source: 'input', path: ['missing'] } } }; },
    definition => { definition.steps[0]!.repeatMapping = definition.steps[0]!.mapping!; },
    definition => {
      const call = definition.steps[0]!;
      assert.ok(call.kind === 'workflow' && call.contract.inputSchema.type === 'object');
      call.contract.inputSchema.fields.context = { schema: { type: 'string' }, default: 42 };
    },
    definition => {
      const call = definition.steps[0]!;
      assert.ok(call.kind === 'workflow');
      call.contract.outputSchema = { type: 'enum', values: [] };
    },
    definition => { definition.steps[2]!.inputSchema = { type: 'number' }; },
  ];
  for (const invalidate of invalidDefinitions) {
    const definition = callRecoveryDefinition();
    invalidate(definition);
    assert.throws(() => mappingSourceGraph(definition));
    assert.throws(() => validateDefinition(definition));
  }
});

test('call mapping sources distinguish loop entry from repeat without changing the definition', () => {
  const definition = structuredClone(mappedCallDefinition);
  definition.steps[0]!.repeatMapping = definition.steps[0]!.mapping!;
  definition.steps.push(
    { id: 'root', name: 'Root', kind: 'typescript', code: '', outputSchema: definition.inputSchema },
    { id: 'check', name: 'Check', kind: 'branch', condition: { operator: 'greater-than', path: ['answer'], value: 0 } },
    { id: 'exit', name: 'Exit', kind: 'typescript', code: '', outputSchema: { type: 'string' } },
  );
  definition.edges = [
    { id: 'entry', from: 'root', to: 'call', outcome: 'success' },
    { id: 'check', from: 'call', to: 'check', outcome: 'success' },
    { id: 'repeat', from: 'check', to: 'call', outcome: 'false' },
    { id: 'exit', from: 'check', to: 'exit', outcome: 'true' },
  ];
  validateDefinition(definition);
  const before = structuredClone(definition);
  const first = mappingChoices(definition, 'call', 'object');
  const repeat = mappingChoices(definition, 'call', 'object', 'repeatMapping');
  assert.ok(first.every(choice => choice.reference.source === 'input' || choice.reference.stepId === 'root'));
  assert.ok(repeat.some(choice => choice.label === 'Call.answer'));
  assert.ok(repeat.some(choice => choice.label === 'Check'));
  assert.ok(!repeat.some(choice => choice.label === 'Exit'));
  assert.deepEqual(definition, before);
});

const contract: WorkflowCallStep['contract'] = { inputSchema: { type: 'object', fields: {} }, outputSchema: { type: 'number' } };

test('explicit contract refresh keeps both mappings and copies host contracts', () => {
  const step: WorkflowCallStep = { id: 'call', name: 'Call', kind: 'workflow', workflowId: 'old', contract,
    mapping: { kind: 'object', fields: {} }, repeatMapping: { kind: 'reference', reference: { source: 'input', path: [] } }, permission: 'ask', timeoutMs: 50 };
  const selection = { id: 'child', name: 'Child', backend: 'fake', contract: { ...contract, outputSchema: { type: 'string' as const } } };
  const refreshed = selectWorkflowContract(step, selection);
  assert.deepEqual(refreshed, { ...step, workflowId: 'child', contract: selection.contract });
  assert.notEqual(refreshed.contract, selection.contract);
  assert.equal(step.workflowId, 'old');
});

test('invocation breadcrumbs retain exact repeated call identities and ancestry', () => {
  const definition = { version: 1 as const, id: 'child', name: 'Child', backend: 'fake', inputSchema: contract.inputSchema, steps: [], edges: [] };
  const invocation: WorkflowInvocation = { id: 'outer', callStepId: 'call', callAttempt: 2, definitionId: 'child', input: {}, startedAt: 0, status: 'running', steps: {} };
  const root: WorkflowExecution = { version: 1, id: 'root', sessionId: 'session', scope: '/tmp', definition, input: {}, status: 'running', startedAt: 0, steps: {}, retainedDefinitions: { child: definition }, invocations: { outer: invocation, inner: { ...invocation, id: 'inner', parentInvocationId: 'outer', callAttempt: 1 } } };
  assert.deepEqual(invocationTrail(root, 'inner'), [{ id: 'outer', name: 'Child', call: 'call', attempt: 2 }, { id: 'inner', name: 'Child', call: 'call', attempt: 1 }]);
  assert.deepEqual(invocationTrail(root, ''), []);
  assert.deepEqual(invocationTrail(root, 'missing'), []);
});

test('activity queries distinguish root and inner attempts, including legacy records', () => {
  assert.equal(workflowActivityQuery('a b', 2, false), 'stepId=a%20b&attempt=2');
  assert.equal(workflowActivityQuery('step', 3, false, 'inner'), 'stepId=step&attempt=3&invocationId=inner');
  assert.equal(workflowActivityQuery('step', 3, true, 'inner'), 'stepId=step&invocationId=inner');
});
