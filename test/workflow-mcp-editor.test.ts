import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { McpToolDiscovery, McpToolSnapshot, WorkflowDefinition, WorkflowStep } from '../src/protocol/workflows.ts';
import type { WorkflowMcpConnections } from '../src/protocol/workflow-mcp-authoring.ts';

type Element = { type: string; props: Record<string, any> };
type McpStep = Extract<WorkflowStep, { kind: 'mcp' }>;
const tool: McpToolSnapshot = {
  connectionId: 'server', connectionName: 'Server', identity: 'tool-identity',
  serverIdentity: 'server-identity', toolName: 'usable', inputSchema: { type: 'object' },
};
const errors = [
  { toolName: 'bad-input', message: 'MCP tool bad-input input schema is incompatible: strict mode: unknown keyword: "example"' },
  { toolName: 'bad-output', message: 'MCP tool bad-output output schema is incompatible: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"' },
];
const compatible: McpToolDiscovery = { tools: [tool], errors: [] };
const catalogue: WorkflowMcpConnections = {
  scope: '/project-a',
  connections: [
    { id: 'server', name: 'Server', transport: 'stdio', enabledByDefault: true },
    { id: 'other', name: 'Other', transport: 'stdio', enabledByDefault: false },
  ],
};

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

const require = createRequire(import.meta.url);
const code = transformSync(readFileSync(new URL('../web/src/components/workflow-mcp.tsx', import.meta.url), 'utf8'), {
  loader: 'tsx', format: 'cjs', jsx: 'automatic',
}).code;

const apiCode = transformSync(readFileSync(new URL('../web/src/components/workflow-api.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs',
}).code;

function editor(projectId: string | undefined = 'project-a', pendingBody = false) {
  const hooks: any[] = [];
  const effects: Array<{ dependencies: unknown[] | undefined; cleanup: (() => void) | undefined }> = [];
  const requests: Array<ReturnType<typeof deferred<any>> & { url: URL; method: string; signal: AbortSignal }> = [];
  const changes: McpStep[] = [];
  const step: McpStep = {
    id: 'mcp', name: 'MCP', kind: 'mcp', tool: { ...tool, toolName: 'pinned' },
    mapping: { kind: 'template', template: { kind: 'literal', value: { saved: 'mapping' } } },
    repeatMapping: { kind: 'template', template: { kind: 'literal', value: { saved: 'repeat' } } },
  };
  const definition: WorkflowDefinition = {
    version: 1, id: 'sample', name: 'Sample', backend: 'fake', projectId,
    inputSchema: { type: 'object', fields: {} }, steps: [step], edges: [],
  };
  let index = 0;
  let dirty = true;
  let mounted = true;
  let lateUpdates = 0;
  let view!: Element;
  let pendingEffects: Array<() => void> = [];
  const module = { exports: {} as { McpStepEditor: (props: unknown) => Element } };
  const api = { exports: {} as { workflowMcpApi: unknown } };
  runInNewContext(apiCode, { module: api, exports: api.exports, AbortController, setTimeout, clearTimeout, require: (name: string) => {
    if (name === 'react') return {};
    if (name === '@/authentication.ts') return {
      authenticatedFetch: (path: string, options: { method: string; body?: unknown; signal: AbortSignal }) => {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        assert.ok(options.signal instanceof AbortSignal);
        const request = { ...deferred<any>(), url: new URL(path, 'http://flow.test'), method: options.method, signal: options.signal };
        requests.push(request);
        return pendingBody
          ? Promise.resolve({ ok: true, json: () => request.promise })
          : request.promise.then(data => ({ ok: true, json: async () => data }));
      },
    };
    throw new Error(`Unexpected API import: ${name}`);
  } });
  runInNewContext(code, { module, exports: module.exports, AbortController, require: (name: string) => {
    if (name === 'react') return {
      useState: (initial: any) => {
        const slot = index++;
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], (value: any) => {
          if (!mounted) { lateUpdates++; return; }
          const next = typeof value === 'function' ? value(hooks[slot]) : value;
          if (!Object.is(hooks[slot], next)) { hooks[slot] = next; dirty = true; }
        }];
      },
      useRef: (initial: any) => hooks[index++] ??= { current: initial },
      useEffect: (effect: () => (() => void) | void, dependencies?: unknown[]) => {
        const slot = index++;
        const previous = effects[slot];
        if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i])) || dependencies.length !== previous.dependencies?.length) {
          pendingEffects.push(() => {
            previous?.cleanup?.();
            effects[slot] = { dependencies, cleanup: effect() ?? undefined };
          });
        }
      },
    };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === './workflow-api.ts') return api.exports;
    if (name === '../../../src/workflows/loops.ts') return { analyzeLoops: () => ({ loops: [] }) };
    if (name === '../../../src/workflows/json-schema.ts') return { validateJsonSchema: () => {} };
    if (name === '../presentation/workflows.ts') return { mappingChoices: () => [] };
    if (name === '../presentation/workflow-json-schema.ts') return {
      initialTemplate: () => ({ kind: 'object', fields: {} }), templateValue: () => ({}),
    };
    if (name === './workflow-json-schema.tsx') return { JsonSchemaEditor: 'JsonSchemaEditor' };
    if (name.startsWith('./ui/')) return new Proxy({}, { get: (_target, key) => key });
    throw new Error(`Unexpected editor import: ${name}`);
  } });
  const render = () => {
    assert.ok(mounted);
    for (let pass = 0; dirty; pass++) {
      assert.ok(pass < 25, 'Render did not settle');
      index = 0; dirty = false; pendingEffects = [];
      view = module.exports.McpStepEditor({ definition, step, onChange: (value: McpStep) => changes.push(value) });
      pendingEffects.forEach(effect => effect());
    }
    return view;
  };
  const settle = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (mounted) render();
  };
  const select = (label: string) => find(render(), 'Select', node => elements(node).some(child => child.props['aria-label'] === label));
  const button = (label: RegExp = /tools|discovery|Discovering/) => find(render(), 'Button', node => label.test(text(node)));
  const latest = () => requests.at(-1)!;
  const ready = async (data: McpToolDiscovery = compatible) => {
    latest().resolve(catalogue);
    await settle();
    latest().resolve(data);
    await settle();
  };
  const refresh = () => { button().props.onClick(); render(); return latest(); };
  const switchProject = (id: string | undefined) => { if (id === undefined) delete definition.projectId; else definition.projectId = id; dirty = true; render(); return latest(); };
  render();
  return {
    render, settle, select, button, latest, ready, refresh, switchProject, step, changes, requests,
    unmount: () => { mounted = false; effects.forEach(effect => effect.cleanup?.()); },
    lateUpdates: () => lateUpdates,
  };
}

function requestScope(request: ReturnType<typeof editor>['requests'][number], path: string, projectId?: string) {
  assert.equal(request.url.pathname, path);
  assert.equal(request.url.searchParams.get('projectId'), projectId ?? null);
  assert.ok([null, '1'].includes(request.url.searchParams.get('refresh')));
  assert.deepEqual([...request.url.searchParams.keys()].filter(key => key !== 'refresh'), projectId ? ['projectId'] : []);
}

it('restores the pinned server and discovers eagerly in the Project Scope without an Agent Session', async () => {
  const p = editor('project / a');
  requestScope(p.latest(), '/api/workflow-mcp', 'project / a');
  assert.equal(p.requests.length, 1);
  p.latest().resolve(catalogue);
  await p.settle();
  assert.equal(p.select('MCP server').props.value, 'server');
  requestScope(p.latest(), '/api/workflow-mcp/server', 'project / a');
  assert.equal(text(p.button()), 'Discovering…');
  p.latest().resolve(compatible);
  await p.settle();
  assert.match(text(p.render()), /Scope: \/project-a/);
  assert.equal(p.requests.length, 2, 'Stable effect dependencies must not refetch');
  assert.equal(p.changes.length, 0);
});

it('discovers and refreshes in the authoring Scope without a Project query', async () => {
  const p = editor();
  const obsolete = p.latest();
  p.switchProject(undefined).resolve({ ...catalogue, scope: '/authoring' });
  obsolete.resolve(catalogue);
  await p.settle();
  requestScope(p.latest(), '/api/workflow-mcp');
  p.select('MCP server').props.onValueChange('server');
  p.render();
  requestScope(p.latest(), '/api/workflow-mcp/server');
  p.latest().resolve(compatible);
  await p.settle();
  assert.match(text(p.render()), /Scope: \/authoring/);
  const refresh = p.refresh();
  requestScope(refresh, '/api/workflow-mcp/server');
  assert.equal(refresh.url.searchParams.get('refresh'), '1');
  refresh.resolve(compatible);
  await p.settle();
});

for (const target of ['project-b', undefined]) {
  it(`uses cached rediscovery after Refresh and Retry in ${target ? 'Project' : 'authoring'} Scope`, async () => {
    const p = editor();
    await p.ready();
    assert.equal(p.latest().url.searchParams.get('refresh'), null);
    const refresh = p.refresh();
    assert.equal(refresh.url.searchParams.get('refresh'), '1');
    refresh.resolve(compatible);
    await p.settle();
    const rediscover = async (id: string) => {
      p.select('MCP server').props.onValueChange(id);
      p.render();
      const request = p.latest();
      requestScope(request, `/api/workflow-mcp/${id}`, 'project-a');
      assert.equal(request.url.searchParams.get('refresh'), null);
      request.resolve(compatible);
      await p.settle();
    };
    await rediscover('other');
    await rediscover('server');
    const failed = p.refresh();
    assert.equal(failed.url.searchParams.get('refresh'), '1');
    failed.reject(new Error('Discovery failed'));
    await p.settle();
    assert.equal(text(p.button()), 'Retry discovery');
    const retry = p.refresh();
    assert.equal(retry.url.searchParams.get('refresh'), '1');
    retry.resolve(compatible);
    await p.settle();
    const count = p.requests.length;
    p.render();
    assert.equal(p.requests.length, count, 'Consuming refresh must not issue an extra request');
    p.switchProject(target).resolve({ ...catalogue, scope: '/new-scope' });
    await p.settle();
    p.select('MCP server').props.onValueChange('server');
    p.render();
    requestScope(p.latest(), '/api/workflow-mcp/server', target);
    assert.equal(p.latest().url.searchParams.get('refresh'), null);
    p.latest().resolve(compatible);
    await p.settle();
    const nextRefresh = p.refresh();
    assert.equal(nextRefresh.url.searchParams.get('refresh'), '1');
    nextRefresh.resolve(compatible);
    await p.settle();
    assert.equal(p.changes.length, 0);
  });
}

it('keeps compatible tools selectable and shows collapsible input/output incompatibility reasons', async () => {
  const p = editor();
  await p.ready({ tools: [tool], errors });
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
  assert.equal(p.changes.length, 0, 'Discovery must preserve pinned identity and mappings');
  assert.equal(find(view, 'JsonSchemaEditor').props.template, p.step.mapping?.kind === 'template' && p.step.mapping.template);
  picker.props.onValueChange(JSON.stringify({ ...tool, toolName: 'bad-input' }));
  assert.equal(p.changes.length, 0);
});

it('distinguishes all-incompatible discovery from an empty server', async () => {
  const p = editor();
  await p.ready({ tools: [], errors });
  assert.match(text(p.render()), /No compatible tools\. All 2 discovered tools are incompatible\./);
  assert.equal(p.select('MCP tool').props.disabled, true);
  assert.equal(elements(p.select('MCP tool')).filter(node => node.type === 'SelectItem').length, 0);
  p.refresh().resolve({ tools: [], errors: [errors[0]!] });
  await p.settle();
  assert.match(text(p.render()), /All 1 discovered tool is incompatible\./);
  p.refresh().resolve({ tools: [], errors: [] });
  await p.settle();
  assert.match(text(p.render()), /This server reported no tools\./);
  assert.doesNotMatch(text(p.render()), /incompatible/);
});

it('clears stale tools on refresh and retry and renders API errors as safe alerts', async () => {
  const p = editor();
  await p.ready({ tools: [tool], errors });
  const pending = p.refresh();
  requestScope(pending, '/api/workflow-mcp/server', 'project-a');
  assert.equal(pending.url.searchParams.get('refresh'), '1');
  assert.equal(text(p.button()), 'Discovering…');
  assert.equal(p.button().props.disabled, true);
  assert.equal(p.select('MCP tool').props.disabled, true);
  assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available/);
  const message = '<img src=x onerror=alert(1)> MCP transport unavailable';
  pending.reject(new Error(message));
  await p.settle();
  const alert = find(p.render(), 'p', node => node.props.role === 'alert');
  assert.equal(text(alert), `Error: ${message}`);
  assert.equal(alert.props.dangerouslySetInnerHTML, undefined);
  assert.equal(text(p.button()), 'Retry discovery');
  assert.equal(p.button().props.disabled, false);
  const retry = p.refresh();
  assert.equal(retry.url.searchParams.get('refresh'), '1');
  assert.equal(elements(p.render()).filter(node => node.props.role === 'alert').length, 0);
  retry.resolve(compatible);
  await p.settle();
  assert.match(text(p.render()), /1 compatible tool available\./);
  assert.equal(p.changes.length, 0);
});

it('shows connection errors as safe alerts and retries the configured servers', async () => {
  const p = editor();
  p.latest().reject(new Error('<script>connection error</script>'));
  await p.settle();
  const alert = find(p.render(), 'p', node => node.props.role === 'alert');
  assert.equal(text(alert), 'Error: <script>connection error</script>');
  assert.equal(alert.props.dangerouslySetInnerHTML, undefined);
  assert.equal(p.select('MCP server').props.disabled, true);
  const retry = p.button(/Retry servers/);
  assert.equal(retry.props.disabled, false);
  retry.props.onClick();
  p.render();
  requestScope(p.latest(), '/api/workflow-mcp', 'project-a');
  assert.doesNotMatch(text(p.render()), /connection error/);
  await p.ready();
  assert.equal(p.select('MCP server').props.disabled, false);
});

for (const target of ['project-b', undefined]) {
  for (const outcome of ['success', 'failure']) {
    it(`resets on ${target ? 'Project' : 'authoring Scope'} switch and rejects stale ${outcome}`, async () => {
      const p = editor();
      await p.ready({ tools: [tool], errors });
      const oldDiscovery = p.refresh();
      const oldConnections = p.switchProject(target);
      assert.equal(oldDiscovery.signal.aborted, true);
      assert.equal(p.select('MCP server').props.value, '');
      assert.equal(p.select('MCP tool').props.disabled, true);
      assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available|Scope: \/project-a/);
      requestScope(oldConnections, '/api/workflow-mcp', target);
      if (outcome === 'success') oldDiscovery.resolve({ tools: [tool], errors });
      else oldDiscovery.reject(new Error('stale discovery failure'));
      await p.settle();
      assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available|stale discovery failure/);
      const currentConnections = p.switchProject('project-c');
      assert.equal(oldConnections.signal.aborted, true);
      if (outcome === 'success') oldConnections.resolve({ ...catalogue, scope: '/stale-scope' });
      else oldConnections.reject(new Error('stale connections failure'));
      await p.settle();
      assert.doesNotMatch(text(p.render()), /stale-scope|stale connections failure/);
      currentConnections.resolve({ ...catalogue, scope: '/project-c' });
      await p.settle();
      assert.equal(p.select('MCP server').props.value, '');
      assert.equal(p.latest(), currentConnections, 'Scope switch must not retarget a pinned tool automatically');
      p.select('MCP server').props.onValueChange('server');
      p.render();
      requestScope(p.latest(), '/api/workflow-mcp/server', 'project-c');
      assert.equal(p.latest().url.searchParams.get('refresh'), null);
      assert.equal(p.button().props.disabled, true);
      p.latest().resolve(compatible);
      await p.settle();
      assert.match(text(p.render()), /1 compatible tool available\./);
      assert.equal(p.changes.length, 0);
    });
  }
}

for (const outcome of ['success', 'failure']) {
  it(`fences stale discovery ${outcome} after a server switch`, async () => {
    const p = editor();
    await p.ready({ tools: [tool], errors });
    const oldRequest = p.refresh();
    p.select('MCP server').props.onValueChange('other');
    p.render();
    const current = p.latest();
    requestScope(current, '/api/workflow-mcp/other', 'project-a');
    assert.equal(current.url.searchParams.get('refresh'), null);
    assert.equal(oldRequest.signal.aborted, true);
    assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available/);
    if (outcome === 'success') oldRequest.resolve({ tools: [tool], errors });
    else oldRequest.reject(new Error('stale failure'));
    await p.settle();
    assert.equal(p.button().props.disabled, true, 'Stale completion must not clear busy');
    assert.doesNotMatch(text(p.render()), /incompatible|compatible tool available|stale failure/);
    current.resolve({ tools: [{ ...tool, connectionId: 'other' }], errors: [] });
    await p.settle();
    assert.equal(p.button().props.disabled, false);
    assert.match(text(p.render()), /1 compatible tool available\./);
    assert.equal(p.changes.length, 0);
  });
}

for (const phase of ['connections', 'discovery']) {
  for (const outcome of ['success', 'failure']) {
    it(`ignores ${phase} ${outcome} after unmount`, async () => {
      const p = editor();
      if (phase === 'discovery') {
        p.latest().resolve(catalogue);
        await p.settle();
      }
      const pending = p.latest();
      p.unmount();
      assert.equal(pending.signal.aborted, true);
      if (outcome === 'success') pending.resolve(phase === 'connections' ? catalogue : compatible);
      else pending.reject(new Error('unmounted failure'));
      await p.settle();
      assert.equal(p.lateUpdates(), 0);
      assert.equal(p.changes.length, 0);
    });
  }
}

for (const pendingBody of [false, true]) {
  for (const phase of ['connections', 'discovery']) {
    it(`times out pending ${phase} ${pendingBody ? 'response bodies' : 'fetches'} and permits Retry without accepting late results`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const p = editor('project-a', pendingBody);
      t.after(() => p.unmount());
      if (phase === 'discovery') {
        p.latest().resolve(catalogue);
        await p.settle();
      }
      const pending = p.latest();
      await p.settle();
      t.mock.timers.tick(14_999);
      await p.settle();
      assert.equal(elements(p.render()).filter(node => node.props.role === 'alert').length, 0);
      assert.equal(p.button(phase === 'connections' ? /Loading servers/ : /Discovering/).props.disabled, true);
      t.mock.timers.tick(1);
      await p.settle();
      assert.equal(pending.signal.aborted, true);
      assert.match(text(find(p.render(), 'p', node => node.props.role === 'alert')), /MCP metadata request timed out after 15 seconds/);
      assert.equal(p.requests.length, phase === 'connections' ? 1 : 2, 'Timeout must not retry automatically');
      const retry = p.button(phase === 'connections' ? /Retry servers/ : /Retry discovery/);
      assert.equal(retry.props.disabled, false);
      retry.props.onClick();
      p.render();
      const current = p.latest();
      pending.resolve(phase === 'connections' ? { ...catalogue, scope: '/late-scope' } : { tools: [tool], errors });
      await p.settle();
      assert.doesNotMatch(text(p.render()), /late-scope|compatible tool available|incompatible/);
      assert.equal(p.button(phase === 'connections' ? /Loading servers/ : /Discovering/).props.disabled, true);
      current.resolve(phase === 'connections' ? catalogue : compatible);
      await p.settle();
      if (phase === 'connections') {
        p.latest().resolve(compatible);
        await p.settle();
      }
      assert.match(text(p.render()), /1 compatible tool available/);
      assert.equal(p.changes.length, 0);
      t.mock.timers.tick(15_000);
      await p.settle();
      assert.equal(elements(p.render()).filter(node => node.props.role === 'alert').length, 0);
      assert.equal(current.signal.aborted, false, 'Successful requests must clear their deadline');
    });

    it(`cleans up a pending ${phase} ${pendingBody ? 'response body' : 'fetch'} deadline on unmount`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const p = editor('project-a', pendingBody);
      if (phase === 'discovery') {
        p.latest().resolve(catalogue);
        await p.settle();
      }
      await p.settle();
      const pending = p.latest();
      p.unmount();
      assert.equal(pending.signal.aborted, true);
      t.mock.timers.tick(15_000);
      pending.resolve(phase === 'connections' ? catalogue : compatible);
      await p.settle();
      assert.equal(p.lateUpdates(), 0);
    });
  }
}

it('preserves pinned mappings during discovery and resets first-entry mapping on exact reselection', async () => {
  const p = editor();
  const pinned = { ...p.step.tool };
  const changed = { ...pinned, identity: 'new-identity', inputSchema: { type: 'object', required: ['value'] } };
  await p.ready({ tools: [pinned, changed], errors: [] });
  const picker = p.select('MCP tool');
  assert.equal(picker.props.value, JSON.stringify(pinned));
  assert.equal(p.changes.length, 0);
  assert.equal(find(p.render(), 'JsonSchemaEditor').props.template, p.step.mapping?.kind === 'template' && p.step.mapping.template);
  picker.props.onValueChange(pinned.toolName);
  picker.props.onValueChange(JSON.stringify({ ...pinned, identity: 'unknown' }));
  assert.equal(p.changes.length, 0, 'Names and unknown snapshots must not select a tool');
  picker.props.onValueChange(JSON.stringify(changed));
  const selected = p.changes.at(-1)!;
  assert.equal(selected.tool, changed);
  assert.equal(selected.mapping?.kind, 'template');
  assert.equal(JSON.stringify(selected.mapping), JSON.stringify({ kind: 'template', template: { kind: 'object', fields: {} } }));
  assert.equal(selected.repeatMapping, p.step.repeatMapping);
});
