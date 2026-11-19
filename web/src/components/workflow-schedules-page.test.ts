import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { WorkflowSchedule } from '../../../src/protocol/workflow-schedules.ts';

const initial: WorkflowSchedule = { version: 1, id: 'one', name: 'Original', workflowId: 'check', input: {}, projectId: '/project', mcpConnectionIds: [], timing: { kind: 'interval', value: 5, unit: 'minutes' }, concurrency: 3, activation: 1, revision: 1, enabled: true, nextDue: 300_000, createdAt: 0, updatedAt: 0 };
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(api: (path: string, method: string, body: any) => Promise<unknown>) {
  const require = createRequire(import.meta.url);
  const states: unknown[] = [];
  const effects: { deps: unknown[]; cleanup?: (() => void) | undefined }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: (() => void)[] = [];
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
    },
  };
  const modules = new Map<string, any>();
  function load(file: string): any {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} as any };
    modules.set(file, module.exports);
    runInNewContext(transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
      module, exports: module.exports, AbortController, setTimeout, clearTimeout,
      require: (name: string) => {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return require(name);
        if (name === '../host.tsx') return { useHost: () => ({ config: {} }) };
        if (name === '../branches.ts') return { useBranches: () => ({}) };
        if (name.endsWith('/schema.ts')) return { parseValue: (_schema: unknown, input: unknown) => input };
        if (name === './use-schedule-mutation.ts') return load(name);
        if (name === './workflow-api.ts') return {
          useWorkflowResource: () => ({ data: { workflows: [{ id: 'check', inputSchema: { type: 'object', fields: {} } }] } }),
          workflowApi: api,
        };
        return new Proxy({}, { get: (_target, key) => key === 'sharedDirectoryWarning' ? () => undefined : key });
      },
    });
    modules.set(file, module.exports);
    return module.exports;
  }
  const { ScheduleForm } = load('./workflow-schedules-page.tsx');
  return {
    render(schedule: WorkflowSchedule, onSaved: (id: string) => void) {
      cursor = 0; effectCursor = 0;
      const tree = ScheduleForm({ schedule, onSaved });
      for (const effect of pending) effect();
      pending = [];
      return tree;
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
  };
}

test('editor retains its field/revision snapshot when polling observes a concurrent pause', async () => {
  const calls: { path: string; method: string; body: any }[] = [];
  let saved = false;
  let current = initial;
  const editor = mount(async (path, method, body) => {
    calls.push({ path, method, body });
    if (body.revision !== current.revision) throw new Error('Schedule revision conflict. Reload before saving.');
    current = { ...current, ...body.settings, enabled: body.enabled, revision: current.revision + 1 };
    return { schedule: current };
  });
  const render = () => editor.render(current, () => { saved = true; });
  try {
    render();
    current = { ...initial, enabled: false, revision: 2, nextDue: undefined };
    render().props.onSubmit({ preventDefault() {} });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.revision, 1);
    assert.equal(calls[0]!.body.enabled, true);
    assert.equal(current.enabled, false);
    assert.equal(current.revision, 2);
    assert.equal(saved, false);
    assert.ok(JSON.stringify(render()).includes('Schedule revision conflict'));
  } finally { editor.unmount(); }
});

for (const outcome of ['resolve', 'reject'] as const) test(`late save ${outcome} cannot affect a replacement editor`, async () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  let navigations = 0;
  const oldEditor = mount(() => response);
  const replacement = mount(async () => ({ schedule: initial }));
  const onSaved = () => { navigations++; };
  try {
    oldEditor.render(initial, onSaved).props.onSubmit({ preventDefault() {} });
    oldEditor.unmount();
    const before = JSON.stringify(replacement.render(initial, onSaved));
    if (outcome === 'resolve') resolve({ schedule: initial });
    else reject(new Error('Late failure'));
    await flush();
    assert.equal(navigations, 0);
    assert.equal(JSON.stringify(replacement.render(initial, onSaved)), before);
  } finally { replacement.unmount(); }
});
