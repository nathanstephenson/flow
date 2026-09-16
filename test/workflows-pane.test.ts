import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { validateDefinition } from '../src/workflows/graph.ts';
import { parseValue } from '../src/workflows/schema.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';

type Element = { type: string; props: Record<string, any> };
const definition: WorkflowDefinition = { version: 1, id: 'sample', name: 'Sample', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'join', name: 'Join', kind: 'join' }], edges: [] };

function pane(status: string) {
  const session = { id: 'session', backend: 'fake', status };
  const history = { data: { occupied: false, executions: [] } };
  const workflow = structuredClone(definition);
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
      useWorkflowResource: (path: string) => path === '/api/workflows' ? { data: { workflows: [workflow] } } : path === '/api/sessions/session/workflows' ? history : {},
      workflowApi: async (...args: unknown[]) => { calls.push(args); return {}; },
    };
    if (name === '../../../src/workflows/graph.ts') return { validateDefinition };
    if (name === '../../../src/workflows/schema.ts') return { parseValue };
    if (name === '../presentation/workflows.ts') return { workflowIssue: (error: Error) => error.message };
    if (name === '../workflow-launch.ts') return {
      retainedWorkflowLaunch: () => undefined,
      clearRetainedWorkflowLaunch: () => {},
    };
    if (name === './workflow-editors.tsx') return { initialValue: () => ({}), ValueEditor: 'ValueEditor' };
    return new Proxy({}, { get: (_target, key) => key });
  } });
  const render = () => { index = 0; return module.exports.default({ sessionId: 'session' }); };
  const button = (label: string) => find(render(), 'Button', node => node.props.children === label);
  const select = () => find(render(), 'Select', node => !!node.props.onValueChange).props.onValueChange('sample');
  return { session, history, workflow, calls, render, button, select };
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
