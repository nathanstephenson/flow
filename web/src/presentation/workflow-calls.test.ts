import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowExecution, WorkflowInvocation } from '../../../src/protocol/workflows.ts';
import { invocationTrail, selectWorkflowContract, workflowActivityQuery, type WorkflowCallStep } from './workflow-calls.ts';

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
