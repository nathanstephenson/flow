import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { McpToolDiscovery, McpToolSnapshot, WorkflowDefinition, WorkflowStep } from '../src/protocol/workflows.ts';

// Exercise the editor's controls and async state using the same JSX harness as workflows-pane.test.ts.
type Element = { type: string; props: Record<string, any> };
const tool: McpToolSnapshot = {
  connectionId: 'server', connectionName: 'Server', identity: 'tool-identity',
  serverIdentity: 'server-identity', toolName: 'usable', inputSchema: { type: 'object' },
};
const errors = [
  { toolName: 'bad-input', message: 'MCP tool bad-input input schema is incompatible: strict mode: unknown keyword: "example"' },
  { toolName: 'bad-output', message: 'MCP tool bad-output output schema is incompatible: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"' },
];

function elements(element: any): Element[] {
  if (!element || typeof element !== 'object' || !element.props) return [];
  return [element, ...[element.props.children].flat(Infinity).flatMap(elements)];
}
function text(element: any): string {
  if (element == null || typeof element === 'boolean') return '';
  if (Array.isArray(element)) return element.map(text).join('');
  return typeof element === 'object' ? text(element.props?.children) : String(element);
}
function find(element: Element, type: string, matches: (element: Element) => boolean = () => true): Element {
  const found = elements(element).find(node => node.type === type && matches(node));
  assert.ok(found, `Missing ${type}`);
  return found;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function editor() {
  const states: any[] = [];
  const refs: any[] = [];
  const cleanups: Array<() => void> = [];
  const calls: string[] = [];
  const changes: WorkflowStep[] = [];
  const connections: { data: any; error?: string } = {
    data: { connections: [{ id: 'server', name: 'Server', transport: 'stdio' }] },
  };
  let index = 0;
  let refIndex = 0;
  let mounted = false;
  let response: Promise<McpToolDiscovery> = Promise.resolve({ tools: [], errors: [] });
  const step: Extract<WorkflowStep, { kind: 'mcp' }> = {
    id: 'mcp', name: 'MCP', kind: 'mcp', tool: { ...tool, toolName: 'pinned' },
    mapping: { kind: 'template', template: { kind: 'literal', value: { saved: 'mapping' } } },
    repeatMapping: { kind: 'template', template: { kind: 'literal', value: { saved: 'repeat' } } },
  };
  const definition: WorkflowDefinition = {
    version: 1, id: 'sample', name: 'Sample', backend: 'fake',
    inputSchema: { type: 'object', fields: {} }, steps: [step], edges: [],
  };
  const module = { exports: {} as { McpStepEditor: (props: unknown) => Element } };
  const require = createRequire(import.meta.url);
  const code = transformSync(readFileSync(new URL('../web/src/components/workflow-mcp.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx', format: 'cjs', jsx: 'automatic',
  }).code;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react') return {
      useState: (initial: any) => {
        const slot = index++;
        if (!(slot in states)) states[slot] = initial;
        return [states[slot], (value: any) => { states[slot] = value; }];
      },
      useRef: (initial: any) => {
        const slot = refIndex++;
        return refs[slot] ??= { current: initial };
      },
      useEffect: (effect: () => () => void) => { if (!mounted) cleanups.push(effect()); },
    };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '../agent-sessions.tsx') return { useAgentSessions: () => ({ sessions: [{ id: 'session', backend: 'fake' }] }) };
    if (name === './workflow-api.ts') return {
      useWorkflowResource: () => connections,
      workflowApi: (path: string) => { calls.push(path); return response; },
    };
    if (name === '../../../src/workflows/loops.ts') return { analyzeLoops: () => ({ loops: [] }) };
    if (name === '../../../src/workflows/json-schema.ts') return { validateJsonSchema: () => {} };
    if (name === '../presentation/workflows.ts') return { mappingChoices: () => [] };
    if (name === '../presentation/workflow-json-schema.ts') return {
      initialTemplate: () => ({ kind: 'object', fields: {} }), templateValue: () => ({}),
    };
    return new Proxy({}, { get: (_target, key) => key });
  } });
  const render = () => {
    index = 0; refIndex = 0;
    const element = module.exports.McpStepEditor({ definition, step, onChange: (value: WorkflowStep) => changes.push(value) });
    mounted = true;
    return element;
  };
  const select = (label: string) => find(render(), 'Select', node => elements(node).some(child => child.props['aria-label'] === label));
  const button = () => find(render(), 'Button');
  const discover = (value: McpToolDiscovery | Promise<McpToolDiscovery>) => {
    response = Promise.resolve(value);
    return button().props.onClick() as Promise<void>;
  };
  select('MCP discovery Agent Session').props.onValueChange('session');
  select('MCP server').props.onValueChange('server');
  return { render, select, button, discover, step, changes, calls, connections, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}

it('keeps compatible tools selectable and shows collapsible input/output incompatibility reasons', async () => {
  const p = editor();
  await p.discover({ tools: [tool], errors });
  assert.equal(p.calls[0], '/api/sessions/session/workflow-mcp/server');
  const view = p.render();
  assert.equal(text(find(view, 'p', node => node.props.role === 'status')), '1 compatible tool available. 2 incompatible tools cannot be selected.');
  const details = elements(find(view, 'section', node => node.props['aria-label'] === 'Incompatible MCP tools')).filter(node => node.type === 'details');
  assert.equal(details.length, 2);
  details.forEach((detail, index) => {
    assert.equal(detail.props.open, undefined);
    assert.equal(text(find(detail, 'summary')), `${errors[index]!.toolName} · incompatible`);
    assert.equal(text(find(detail, 'p')), errors[index]!.message);
    assert.match(find(detail, 'summary').props.className, /focus-visible:ring-ring/);
  });
  const picker = p.select('MCP tool');
  assert.equal(picker.props.disabled, false);
  assert.deepEqual(elements(picker).filter(node => node.type === 'SelectItem').map(text), ['usable']);
  assert.equal(p.changes.length, 0, 'discovery must not change pinned identity or mappings');
  assert.equal(find(view, 'JsonSchemaEditor').props.template, p.step.mapping?.kind === 'template' && p.step.mapping.template);
  picker.props.onValueChange('bad-input');
  assert.equal(p.changes.length, 0);
  picker.props.onValueChange('usable');
  const selected = p.changes[0]!;
  assert.equal(selected.kind === 'mcp' && selected.tool, tool);
  assert.equal(selected.repeatMapping, p.step.repeatMapping);
});

it('distinguishes all-incompatible discovery from an empty server', async () => {
  const p = editor();
  await p.discover({ tools: [], errors });
  assert.match(text(p.render()), /No compatible tools\. All 2 discovered tools are incompatible\./);
  assert.equal(p.select('MCP tool').props.disabled, true);
  assert.equal(elements(p.select('MCP tool')).filter(node => node.type === 'SelectItem').length, 0);
  await p.discover({ tools: [], errors: [errors[0]!] });
  assert.match(text(p.render()), /All 1 discovered tool is incompatible\./);
  await p.discover({ tools: [], errors: [] });
  assert.match(text(p.render()), /This server reported no tools\./);
  assert.doesNotMatch(text(p.render()), /incompatible/);
});

it('clears stale discovery on retry and preserves API and connection errors as alerts', async () => {
  const p = editor();
  await p.discover({ tools: [tool], errors });
  const pending = deferred<McpToolDiscovery>();
  const work = p.discover(pending.promise);
  assert.equal(text(p.button()), 'Discovering…');
  assert.equal(p.button().props.disabled, true);
  assert.equal(p.select('MCP tool').props.disabled, true);
  assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available/);
  p.connections.error = 'Cannot load enabled connections';
  pending.reject(new Error('MCP transport unavailable'));
  await work;
  const alerts = elements(p.render()).filter(node => node.props.role === 'alert').map(text);
  assert.deepEqual(alerts, ['Error: MCP transport unavailable', 'Cannot load enabled connections']);
  assert.equal(p.button().props.disabled, false);
  assert.equal(p.changes.length, 0);
});

for (const label of ['MCP discovery Agent Session', 'MCP server']) {
  it(`resets discovery on ${label} change and ignores stale success and failure`, async () => {
    const p = editor();
    await p.discover({ tools: [tool], errors });
    const pending = deferred<McpToolDiscovery>();
    const oldWork = p.discover(pending.promise);
    p.select(label).props.onValueChange('other');
    assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available/);
    assert.equal(p.select('MCP tool').props.disabled, true);
    if (label === 'MCP discovery Agent Session') p.select('MCP server').props.onValueChange('other-server');
    const newer = deferred<McpToolDiscovery>();
    const newWork = p.discover(newer.promise);
    pending.resolve({ tools: [tool], errors });
    await oldWork;
    assert.equal(p.button().props.disabled, true, 'stale finally must not clear busy');
    assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available/);
    newer.resolve({ tools: [tool], errors: [] });
    await newWork;
    assert.match(text(p.render()), /1 compatible tool available\./);
    const failing = deferred<McpToolDiscovery>();
    const failedWork = p.discover(failing.promise);
    p.select(label).props.onValueChange('third');
    failing.reject(new Error('stale failure'));
    await failedWork;
    assert.doesNotMatch(text(p.render()), /stale failure/);
    assert.equal(p.changes.length, 0);
  });
}

it('ignores discovery completion after unmount', async () => {
  const p = editor();
  const pending = deferred<McpToolDiscovery>();
  const work = p.discover(pending.promise);
  p.unmount();
  pending.resolve({ tools: [tool], errors });
  await work;
  assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available/);
});
