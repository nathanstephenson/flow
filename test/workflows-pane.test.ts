import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { validateDefinition } from '../src/workflows/graph.ts';
import { parseValue } from '../src/workflows/schema.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';

type Element = { type: string; key?: string | null; props: Record<string, any> };
const definition: WorkflowDefinition = { version: 1, id: 'sample', name: 'Sample', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'join', name: 'Join', kind: 'join' }], edges: [] };

function pane(status: string) {
  const session = { id: 'session', backend: 'fake', status };
  const history: { data: { occupied: boolean; executions: any[] } } = { data: { occupied: false, executions: [] } };
  const workflow = structuredClone(definition);
  const detail: { data?: any } = {};
  const calls: unknown[] = [];
  const states: any[] = [];
  let index = 0;
  const module = { exports: {} as { default: (props: unknown) => Element } };
  const require = createRequire(import.meta.url);
  const code = transformSync(readFileSync(new URL('../web/src/components/workflows-pane.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react') return {
      useState: (initial: any) => { const slot = index++; if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial; return [states[slot], (value: any) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }]; },
      useEffect: () => {},
    };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '../agent-sessions.tsx') return { useAgentSessions: () => ({ sessions: [session] }) };
    if (name === './workflow-api.ts') return {
      useWorkflowResource: (path: string) => path === '/api/workflows' ? { data: { workflows: [workflow] } } : path === '/api/sessions/session/workflows' ? history : path?.endsWith('/execution') ? detail : {},
      workflowApi: async (...args: unknown[]) => { calls.push(args); return {}; },
    };
    if (name === '../../../src/workflows/graph.ts') return { validateDefinition };
    if (name === '../../../src/workflows/schema.ts') return { parseValue };
    if (name === '../presentation/workflows.ts') return { workflowIssue: (error: Error) => error.message };
    if (name === '../presentation/workflow-execution.ts') return { attemptDuration: () => '1s' };
    if (name === '../workflow-launch.ts') return {
      retainedWorkflowLaunch: () => undefined,
      clearRetainedWorkflowLaunch: () => {},
    };
    if (name === './workflow-editors.tsx') return { initialValue: () => ({}), ValueEditor: 'ValueEditor' };
    return new Proxy({}, { get: (_target, key) => key });
  } });
  const render = (props: Record<string, unknown> = {}) => { index = 0; return module.exports.default({ sessionId: 'session', ...props }); };
  const button = (label: string) => find(render(), 'Button', node => node.props.children === label);
  const select = () => find(render(), 'Select', node => !!node.props.onValueChange).props.onValueChange('sample');
  return { session, history, workflow, detail, calls, render, button, select };
}

function find(element: any, type: string, matches: (element: Element) => boolean = () => true): Element {
  if (element?.type === type && matches(element)) return element;
  for (const child of [element?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== 'object') continue;
    try { return find(child, type, matches); } catch {}
  }
  throw new Error(`Missing ${type}`);
}

for (const status of ['running', 'awaiting']) it(`allows workflow launch while the parent is ${status} with a free slot`, async () => {
  const p = pane(status);
  assert.equal(p.button('New workflow').props.disabled, false);
  p.button('New workflow').props.onClick();
  p.select();
  assert.equal(p.button('Start workflow').props.disabled, false);
  p.button('Start workflow').props.onClick();
  assert.equal(p.button('Start workflow').props.disabled, true);
  await Promise.resolve();
  assert.equal(JSON.stringify(p.calls), JSON.stringify([['/api/sessions/session/workflows', 'POST', { workflowId: 'sample', input: {} }]]));
});

it('keeps occupied-slot, Ended, input and Backend Adapter guards', () => {
  const p = pane('idle');
  p.history.data.occupied = true;
  assert.equal(p.button('New workflow').props.disabled, true);
  p.history.data.occupied = false;
  p.button('New workflow').props.onClick();
  p.select();
  p.session.status = 'ended';
  assert.equal(p.button('Close').props.disabled, true);
  assert.equal(p.button('Start workflow').props.disabled, true);
  p.session.status = 'running';
  p.session.backend = 'other';
  assert.equal(p.button('Start workflow').props.disabled, true);
  p.session.backend = 'fake';
  p.workflow.inputSchema = { type: 'object', fields: { required: { schema: { type: 'string' }, required: true } } };
  assert.equal(p.button('Start workflow').props.disabled, true);
  p.workflow.inputSchema = definition.inputSchema;
  assert.equal(p.button('Start workflow').props.disabled, false);
  p.history.data.occupied = true;
  assert.equal(p.button('Close').props.disabled, true);
  assert.throws(() => p.button('Start workflow'), /Missing Button/);
  assert.equal(p.calls.length, 0);
});

it('uses shared lifecycle-preserving tabs for execution overview, graph and step navigation', () => {
  const p = pane('idle');
  const execution = {
    id: 'execution',
    definition: structuredClone(definition),
    input: {},
    startedAt: 1,
    status: 'completed',
    steps: {
      join: {
        status: 'completed',
        attempts: [{ number: 1, action: 'run', startedAt: 1, finishedAt: 2, input: {}, output: {} }],
      },
    },
    result: { ok: true },
  };
  p.history.data.executions = [{ id: 'execution', name: 'Sample', status: 'completed', startedAt: 1 }];
  p.detail.data = { execution, enquiries: [], permissions: [], stepSpend: {}, historyComplete: true };
  find(p.render(), 'Select', node => Array.isArray(node.props.items)).props.onValueChange('execution');

  const overview = p.render();
  const tabs = find(overview, 'Tabs');
  assert.equal(tabs.props.value, 'Overview');
  assert.equal(find(overview, 'TabsList').props['aria-label'], 'Workflow execution view');
  assert.equal(find(overview, 'TabsTrigger', node => node.props.value === 'Overview').props.children, 'Overview');
  assert.equal(find(overview, 'TabsTrigger', node => node.props.value === 'Flow').props.children, 'Flow');
  assert.equal(find(overview, 'TabsContent', node => node.props.value === 'Overview').props.keepMounted, undefined);
  assert.equal(find(overview, 'TabsContent', node => node.props.value === 'Flow').props.keepMounted, true);
  assert.match(JSON.stringify(find(overview, 'TabsContent', node => node.props.value === 'Overview')), /Original launch snapshot/);
  assert.match(JSON.stringify(find(overview, 'TabsContent', node => node.props.value === 'Overview')), /Result/);

  tabs.props.onValueChange('Flow');
  const flow = p.render();
  assert.equal(find(flow, 'Tabs').props.value, 'Flow');
  const rightGraph = find(flow, 'WorkflowGraph');
  assert.equal(rightGraph.props.orientation, 'vertical');
  assert.equal(rightGraph.key, 'execution/right');
  const bottomGraph = find(p.render({ placement: 'bottom' }), 'WorkflowGraph');
  assert.equal(bottomGraph.props.orientation, 'horizontal');
  assert.equal(bottomGraph.key, 'execution/bottom');
  find(flow, 'WorkflowGraph').props.onSelect('join');
  const step = p.render();
  assert.equal(find(step, 'Tabs').props.value, 'Flow');
  // The graph stays mounted (but hidden by its wrapper), retaining pan/zoom across details and Back.
  assert.ok(find(step, 'WorkflowGraph'));
  assert.ok(find(step, 'Select', node => node.props.value === 1));
  find(step, 'Button', node => [node.props.children].flat(Infinity).includes('Back to flow')).props.onClick();
  assert.ok(find(p.render(), 'WorkflowGraph'));
});
