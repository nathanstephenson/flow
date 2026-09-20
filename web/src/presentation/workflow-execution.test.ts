import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attemptDuration, executionLayout, outcomePorts } from './workflow-execution.ts';
import type { WorkflowDefinition } from '../../../src/protocol/workflows.ts';

it('truncates attempt durations, omits zero units and preserves unfinished attempts', () => {
  for (const [ms, expected] of [[0, '0s'], [999, '0s'], [1000, '1s'], [59999, '59s'], [60000, '1m'], [61999, '1m 1s'], [3599999, '59m 59s'], [3600000, '1h'], [3601000, '1h 1s']] as const) assert.equal(attemptDuration(123, 123 + ms), expected);
  assert.equal(attemptDuration(123), 'In progress');
});

it('keeps every outcome label paired with a right or bottom source port', () => {
  assert.deepEqual(outcomePorts('branch', true), [
    { outcome: 'true', side: 'bottom' },
    { outcome: 'false', side: 'bottom' },
  ]);
  assert.deepEqual(outcomePorts('agent', true), [
    { outcome: 'success', side: 'bottom' },
    { outcome: 'failure', side: 'bottom' },
    { outcome: 'timeout', side: 'bottom' },
  ]);
  assert.deepEqual(outcomePorts('join', false), [
    { outcome: 'success', side: 'right' },
    { outcome: 'failure', side: 'right' },
    { outcome: 'timeout', side: 'right' },
  ]);
});

it('lays out branches in either direction without altering the launch/editor snapshot', () => {
  const definition: WorkflowDefinition = { version: 1, id: 'layout', name: 'Layout', backend: 'fake', inputSchema: { type: 'object', fields: { ready: { schema: { type: 'boolean' }, required: true } } }, steps: [
    { id: 'check', name: 'Check', kind: 'branch', condition: { operator: 'equals', path: ['ready'], value: true }, position: { x: 99, y: 99 } },
    { id: 'yes', name: 'Yes', kind: 'join' }, { id: 'no', name: 'No', kind: 'join' },
  ], edges: [{ id: 'yes', from: 'check', to: 'yes', outcome: 'true' }, { id: 'no', from: 'check', to: 'no', outcome: 'false' }] };
  const snapshot = structuredClone(definition);
  const vertical = executionLayout(definition, true), horizontal = executionLayout(definition, false);
  assert.equal(vertical.steps[1]!.position!.y, vertical.steps[2]!.position!.y);
  assert.notEqual(vertical.steps[1]!.position!.x, vertical.steps[2]!.position!.x);
  assert.equal(horizontal.steps[1]!.position!.x, horizontal.steps[2]!.position!.x);
  assert.notEqual(horizontal.steps[1]!.position!.y, horizontal.steps[2]!.position!.y);
  assert.deepEqual(vertical.edges, definition.edges);
  assert.deepEqual(definition, snapshot);
});
