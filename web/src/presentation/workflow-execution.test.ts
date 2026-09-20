import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attemptDuration, EDITOR_MIN_ZOOM, EXECUTION_MIN_ZOOM, executionLayout } from './workflow-execution.ts';
import type { WorkflowDefinition } from '../../../src/protocol/workflows.ts';
import { validateDefinition } from '../../../src/workflows/graph.ts';
import { absolutePosition, loopLayout } from './workflow-loops.ts';

it('truncates attempt durations, omits zero units and preserves unfinished attempts', () => {
  for (const [ms, expected] of [[0, '0s'], [999, '0s'], [1000, '1s'], [59999, '59s'], [60000, '1m'], [61999, '1m 1s'], [3599999, '59m 59s'], [3600000, '1h'], [3601000, '1h 1s']] as const) assert.equal(attemptDuration(123, 123 + ms), expected);
  assert.equal(attemptDuration(123), 'In progress');
});

it('keeps the editor zoom floor while allowing execution overviews to zoom farther out', () => {
  assert.equal(EDITOR_MIN_ZOOM, 0.1);
  assert.equal(EXECUTION_MIN_ZOOM, 0.05);
});

function loopBoxes(definition: WorkflowDefinition, vertical: boolean) {
  const nodes = loopLayout(executionLayout(definition, vertical), {
    orientation: vertical ? 'vertical' : 'horizontal',
  });
  return nodes.filter(node => node.type === 'loop').map(node => ({
    id: node.id,
    ...absolutePosition(node, nodes),
    width: Number(node.style?.width),
    height: Number(node.style?.height),
  }));
}

const sequentialLoops: WorkflowDefinition = {
  version: 1, id: 'sequential-loops', name: 'Sequential loops', backend: 'fake',
  inputSchema: { type: 'object', fields: { ok: { schema: { type: 'boolean' }, required: true } } },
  steps: ['start', 'first', 'first-work', 'second', 'second-work', 'done'].map(id =>
    id === 'first' || id === 'second'
      ? { id, name: id, kind: 'branch' as const, condition: { operator: 'truthy' as const, path: ['ok'] } }
      : { id, name: id, kind: 'join' as const }),
  edges: [
    { id: 'start', from: 'start', to: 'first', outcome: 'success' },
    { id: 'a', from: 'first', to: 'first-work', outcome: 'false' },
    { id: 'b', from: 'first-work', to: 'first', outcome: 'success' },
    { id: 'c', from: 'first', to: 'second', outcome: 'true' },
    { id: 'd', from: 'second', to: 'second-work', outcome: 'false' },
    { id: 'e', from: 'second-work', to: 'second', outcome: 'success' },
    { id: 'f', from: 'second', to: 'done', outcome: 'true' },
  ],
};

it('keeps sequential sibling loop bounds apart along either rank axis', () => {
  for (const vertical of [false, true]) {
    const [first, second] = loopBoxes(sequentialLoops, vertical);
    assert.ok(first && second);
    assert.ok(vertical
      ? first.y + first.height <= second.y
      : first.x + first.width <= second.x);
  }
});

it('keeps sequential nested sibling loop bounds apart along either rank axis', () => {
  const nested: WorkflowDefinition = {
    ...sequentialLoops,
    id: 'nested-siblings',
    steps: [
      { id: 'outer', name: 'outer', kind: 'branch', condition: { operator: 'truthy', path: ['ok'] } },
      ...sequentialLoops.steps,
    ],
    edges: [
      { id: 'root', from: 'start', to: 'outer', outcome: 'success' },
      { id: 'outer-enter', from: 'outer', to: 'first', outcome: 'false' },
      ...sequentialLoops.edges.slice(1, -1),
      { id: 'outer-back', from: 'second', to: 'outer', outcome: 'true' },
      { id: 'outer-exit', from: 'outer', to: 'done', outcome: 'true' },
    ],
  };
  for (const vertical of [false, true]) {
    const boxes = loopBoxes(nested, vertical).filter(box => box.id !== 'loop:outer');
    assert.equal(boxes.length, 2);
    assert.ok(vertical
      ? boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y
      : boxes[0]!.x + boxes[0]!.width <= boxes[1]!.x);
  }
});

function assertRectanglesDoNotIntersect(definition: WorkflowDefinition) {
  assert.doesNotThrow(() => validateDefinition(definition));
  for (const vertical of [false, true]) {
    const boxes = loopBoxes(definition, vertical);
    for (let left = 0; left < boxes.length; left++) for (let right = left + 1; right < boxes.length; right++) {
      const a = boxes[left]!, b = boxes[right]!;
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x ||
        a.y + a.height <= b.y || b.y + b.height <= a.y,
      `${a.id} intersects ${b.id} in ${vertical ? 'vertical' : 'horizontal'} layout`);
    }
  }
}

it('places a non-header loop exit after the complete loop rectangle', () => {
  const definition: WorkflowDefinition = {
    version: 1, id: 'non-header-exit', name: 'Non-header exit', backend: 'fake',
    inputSchema: { type: 'object', fields: { ok: { schema: { type: 'boolean' }, required: true } } },
    steps: [
      { id: 'start', name: 'start', kind: 'typescript', code: 'return true', outputSchema: { type: 'boolean' } },
      { id: 'header', name: 'header', kind: 'branch', condition: { operator: 'truthy', path: [] } },
      { id: 'body', name: 'body', kind: 'branch', condition: { operator: 'truthy', path: [] } },
      { id: 'done', name: 'done', kind: 'join' },
    ],
    edges: [
      { id: 'start', from: 'start', to: 'header', outcome: 'success' },
      { id: 'enter', from: 'header', to: 'body', outcome: 'false' },
      { id: 'retry', from: 'body', to: 'header', outcome: 'false' },
      { id: 'exit', from: 'body', to: 'done', outcome: 'true' },
    ],
  };
  assert.doesNotThrow(() => validateDefinition(definition));
  for (const vertical of [false, true]) {
    const laidOut = executionLayout(definition, vertical);
    const nodes = loopLayout(laidOut, { orientation: vertical ? 'vertical' : 'horizontal' });
    const loop = nodes.find(node => node.type === 'loop')!;
    const done = nodes.find(node => node.id === 'done')!;
    const loopPosition = absolutePosition(loop, nodes), donePosition = absolutePosition(done, nodes);
    assert.ok(vertical
      ? loopPosition.y + Number(loop.style?.height) <= donePosition.y
      : loopPosition.x + Number(loop.style?.width) <= donePosition.x);
  }
});

it('reserves non-overlapping rectangles for parallel branching sibling loops', () => {
  const branch = (id: string) => ({ id, name: id, kind: 'branch' as const, condition: { operator: 'equals' as const, path: [], value: true } });
  const join = (id: string) => ({ id, name: id, kind: 'join' as const });
  const booleanStep = (id: string) => ({ id, name: id, kind: 'typescript' as const, code: 'return true', outputSchema: { type: 'boolean' as const } });
  const definition: WorkflowDefinition = {
    version: 1, id: 'parallel-loops', name: 'Parallel loops', backend: 'fake',
    inputSchema: { type: 'object', fields: { ok: { schema: { type: 'boolean' }, required: true } } },
    steps: [booleanStep('start'), branch('a'), branch('a-body'), booleanStep('a-left'), booleanStep('a-right'), branch('b'), booleanStep('b-body'), join('done')],
    edges: [
      { id: 'to-a', from: 'start', to: 'a', outcome: 'success' }, { id: 'to-b', from: 'start', to: 'b', outcome: 'success' },
      { id: 'a-enter', from: 'a', to: 'a-body', outcome: 'false' }, { id: 'a-exit', from: 'a', to: 'done', outcome: 'true' },
      { id: 'a-left', from: 'a-body', to: 'a-left', outcome: 'true' }, { id: 'a-right', from: 'a-body', to: 'a-right', outcome: 'false' },
      { id: 'a-left-back', from: 'a-left', to: 'a', outcome: 'success' }, { id: 'a-right-back', from: 'a-right', to: 'a', outcome: 'success' },
      { id: 'b-enter', from: 'b', to: 'b-body', outcome: 'false' }, { id: 'b-back', from: 'b-body', to: 'b', outcome: 'success' },
      { id: 'b-exit', from: 'b', to: 'done', outcome: 'true' },
    ],
  };
  assertRectanglesDoNotIntersect(definition);
});

it('lays out branches in either direction without altering the launch/editor snapshot', () => {
  const definition: WorkflowDefinition = { version: 1, id: 'layout', name: 'Layout', backend: 'fake', inputSchema: { type: 'object', fields: { ready: { schema: { type: 'boolean' }, required: true } } }, steps: [
    { id: 'check', name: 'Check', kind: 'branch', condition: { operator: 'equals', path: ['ready'], value: true }, position: { x: 99, y: 99 } },
    { id: 'yes', name: 'Yes', kind: 'join' }, { id: 'no', name: 'No', kind: 'join' },
  ], edges: [
    { id: 'yes', from: 'check', to: 'yes', outcome: 'true' },
    { id: 'no', from: 'check', to: 'no', outcome: 'false' },
    { id: 'recover', from: 'check', to: 'no', outcome: 'failure' },
    { id: 'timed-out', from: 'check', to: 'no', outcome: 'timeout' },
  ] };
  assert.doesNotThrow(() => validateDefinition(definition));
  const snapshot = structuredClone(definition);
  const vertical = executionLayout(definition, true), horizontal = executionLayout(definition, false);
  assert.equal(vertical.steps[1]!.position!.y, vertical.steps[2]!.position!.y);
  assert.notEqual(vertical.steps[1]!.position!.x, vertical.steps[2]!.position!.x);
  assert.equal(horizontal.steps[1]!.position!.x, horizontal.steps[2]!.position!.x);
  assert.notEqual(horizontal.steps[1]!.position!.y, horizontal.steps[2]!.position!.y);
  assert.deepEqual(vertical.edges, definition.edges);
  assert.deepEqual(definition, snapshot);
});
