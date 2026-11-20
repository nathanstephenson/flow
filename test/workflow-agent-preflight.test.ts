import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowEnvironment } from '../src/daemon/workflow-environment.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import type { ModelInfo } from '../src/protocol/events.ts';
import type { WorkflowDefinition, WorkflowStep } from '../src/protocol/workflows.ts';
import { deriveResultSchema } from '../src/workflows/calls.ts';
import { WorkflowStore } from '../src/workflows/store.ts';

const agent: Extract<WorkflowStep, { kind: 'agent' }> = { id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'Return JSON', outputSchema: { type: 'string' } };
const definition: WorkflowDefinition = { version: 1, id: 'preflight', name: 'Preflight', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [agent], edges: [] };
const call = (target: WorkflowDefinition): WorkflowStep => ({ id: 'call', name: 'Call', kind: 'workflow', workflowId: target.id, mapping: { kind: 'reference', reference: { source: 'input', path: [] } }, contract: { inputSchema: target.inputSchema, outputSchema: deriveResultSchema(target) } });
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out');
}
async function fixture(t: import('node:test').TestContext, models?: ModelInfo[]) {
  const root = mkdtempSync(join(tmpdir(), 'flow-agent-preflight-'));
  const transcripts = new TranscriptStore(root), store = new WorkflowStore(root), config = new ConfigStore(root);
  config.update({ filesystemIsolation: 'none', workflowRuntime: { nodePath: process.execPath } });
  const host = new SessionHost({ store: transcripts, filesystemIsolationMode: () => 'none' });
  const backend = new FakeBackend(models ? { models } : {}); host.registerBackend(backend);
  const service = new WorkflowExecutionService(host, store, new SecretStore(root), config, '/unused');
  let attaches = 0;
  const launch = (graph = definition, input = {}, signal?: AbortSignal) => service.startScheduled({ occurrenceId: 'preflight', definition: graph, input, scope: root, projectId: root, mcpConnectionIds: [], ...(signal ? { signal } : {}),
    attach: () => { attaches++; return host.attachScheduled({ scope: root, backend: 'fake', scheduled: { id: 'parent', occurrenceId: 'preflight' } }); },
  });
  await host.load();
  t.after(async () => { await service.stopScheduled(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  function noAgentWork() {
    assert.equal(attaches, 0); assert.deepEqual(host.list(), []);
    assert.deepEqual(store.listExecutions('occurrence-preflight'), []);
    assert.equal(existsSync(join(root, 'sessions')), false);
    for (const session of backend.sessions) {
      assert.equal(session.toolless, true); assert.deepEqual(session.prompts, []);
      assert.deepEqual(session.workflowSubagents, []); assert.deepEqual(session.subagents, []);
    }
  }
  return { root, host, backend, service, store, launch, noAgentWork };
}

for (const [change, error] of [
  [{ model: 'missing' }, /Agent model.*unavailable/],
  [{ model: '${input.model}' }, /Agent model.*unavailable/],
  [{ effort: 'max' }, /Effort.*unsupported/],
] as const) test(`scheduled preflight rejects ${JSON.stringify(change)} before earlier shell/MCP effects`, async t => {
  const f = await fixture(t);
  const prepare = t.mock.method(WorkflowEnvironment.prototype, 'prepare');
  const discover = t.mock.method(f.service, 'discoverMcp');
  const graph: WorkflowDefinition = { ...definition, steps: [
    { id: 'shell', name: 'Shell', kind: 'shell', command: `touch '${join(f.root, 'effect')}'` },
    { id: 'mcp', name: 'MCP', kind: 'mcp', tool: { connectionId: 'local', connectionName: 'Local', identity: 'a'.repeat(64), serverIdentity: 'b'.repeat(64), toolName: 'write', inputSchema: { type: 'object' } } },
    { ...agent, ...change },
  ], edges: [{ id: 'first', from: 'shell', to: 'mcp', outcome: 'success' }, { id: 'next', from: 'mcp', to: 'agent', outcome: 'success' }] };
  await assert.rejects(f.launch(graph), error);
  assert.equal(prepare.mock.callCount(), 0); assert.equal(discover.mock.callCount(), 0);
  assert.equal(existsSync(join(f.root, 'effect')), false);
  assert.equal(f.backend.sessions.length, 1); f.noAgentWork();
});

test('all branches and nested called definitions are checked before launch', async t => {
  const f = await fixture(t);
  const child = { ...definition, id: 'child', steps: [{ ...agent, model: 'missing' }] };
  const middle = { ...definition, id: 'middle', steps: [call(child)] };
  f.store.saveDefinition(child); f.store.saveDefinition(middle);
  const graph: WorkflowDefinition = { ...definition, steps: [
    { id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'equals', path: [], value: { never: true } } }, call(middle),
  ], edges: [{ id: 'unreached', from: 'branch', to: 'call', outcome: 'true' }] };
  await assert.rejects(f.service.validateScheduledAgents(graph, {}, f.root), /Agent model.*unavailable/);
  await assert.rejects(f.launch(graph), /Agent model.*unavailable/);
  assert.equal(f.backend.sessions.length, 1); f.noAgentWork();
});

for (const invalid of ['input', 'effort-template', 'missing-call', 'backend', 'project', 'contract'] as const) test(`${invalid} fails before a catalogue probe`, async t => {
  const f = await fixture(t);
  let graph = definition;
  let input = {};
  if (invalid === 'input') graph = { ...definition, inputSchema: { type: 'object', fields: { required: { schema: { type: 'string' }, required: true } } } };
  if (invalid === 'effort-template') graph = { ...definition, steps: [{ ...agent, effort: '${input.effort}' as never }] };
  if (['missing-call', 'backend', 'project', 'contract'].includes(invalid)) {
    const child: WorkflowDefinition = { ...definition, id: 'child', ...(invalid === 'backend' ? { backend: 'other' } : {}), ...(invalid === 'project' ? { projectId: '/missing-project' } : {}) };
    graph = { ...definition, steps: [call(child)] };
    if (invalid === 'contract') child.steps = [{ ...agent, outputSchema: { type: 'number' } }];
    if (invalid !== 'missing-call') f.store.saveDefinition(child);
  }
  await assert.rejects(f.service.validateScheduledAgents(graph, input, f.root));
  await assert.rejects(f.launch(graph, input));
  assert.equal(f.backend.sessions.length, 0); f.noAgentWork();
});

test('root Project restrictions fail before probing even when a Worktree Scope differs', async t => {
  const f = await fixture(t);
  await f.service.validateScheduledAgents({ ...definition, projectId: f.root }, {}, '/not-provisioned-worktree', f.root);
  assert.equal(f.backend.sessions.length, 1);
  await assert.rejects(f.service.validateScheduledAgents({ ...definition, projectId: '/missing-project' }, {}, f.root), /another Project/);
  f.noAgentWork();
});

test('concurrent preflights reuse the host catalogue and never probe unrelated Backends or Summary Models', async t => {
  const f = await fixture(t);
  const other = new FakeBackend();
  f.host.registerBackend({ name: 'other', create: options => other.create(options) });
  await Promise.all(Array.from({ length: 4 }, () => f.service.validateScheduledAgents(definition, {}, f.root)));
  await f.service.validateScheduledAgents(definition, {}, f.root);
  assert.equal(f.backend.sessions.length, 1); assert.equal(other.sessions.length, 0);
  assert.deepEqual(await f.host.models(f.root, false, 'fake'), [{ backend: 'fake', models: f.backend.sessions[0]!.capabilities.models }]);
  f.noAgentWork();
});

test('a Backend Session without Workflow agent support fails before resources start', async t => {
  const f = await fixture(t);
  const create = f.backend.create.bind(f.backend);
  t.mock.method(f.backend, 'create', async (options: Parameters<typeof create>[0]) => {
    const session = await create(options); Object.defineProperty(session, 'startWorkflowSubagent', { value: undefined }); return session;
  });
  const prepare = t.mock.method(WorkflowEnvironment.prototype, 'prepare');
  await assert.rejects(f.launch(), /agent capabilities are unavailable/);
  assert.equal(prepare.mock.callCount(), 0); f.noAgentWork();
});

test('catalogue failures fail closed without attachment or resource preparation', async t => {
  const f = await fixture(t);
  t.mock.method(f.backend, 'create', async () => { throw new Error('Metadata unavailable'); });
  const prepare = t.mock.method(WorkflowEnvironment.prototype, 'prepare');
  await assert.rejects(f.launch(), /Metadata unavailable/);
  assert.equal(prepare.mock.callCount(), 0); f.noAgentWork();
});

for (const effort of ['off', 'high'] as const) test(`confirmed no-control ${effort} preserves the manual off-sentinel policy`, async t => {
  const f = await fixture(t, [{ id: 'plain' }]);
  const graph = { ...definition, steps: [{ ...agent, model: 'plain', effort }] };
  await f.service.validateScheduledAgents(graph, {}, f.root);
  const view = await f.launch(graph);
  await until(() => f.backend.sessions.some(session => session.workflowSubagents.length === 1));
  const session = f.backend.sessions.find(session => !session.toolless)!;
  assert.equal(session.workflowSubagents[0]!.options.effort, 'off');
  session.workflowSubagents[0]!.complete('"done"');
  const result = await f.service.scheduler.wait('occurrence-preflight', view.execution.id);
  assert.equal(result.status, 'completed'); assert.equal(f.backend.sessions.length, 2);
  assert.ok(f.backend.sessions.every(session => session.prompts.length === 0));
});

test('cancellation during metadata discovery stops before environment effects', async t => {
  const f = await fixture(t);
  f.backend.holdCreate = true;
  const create = t.mock.method(f.backend, 'create');
  const prepare = t.mock.method(WorkflowEnvironment.prototype, 'prepare');
  const controller = new AbortController();
  const launching = f.launch(definition, {}, controller.signal);
  await until(() => create.mock.callCount() === 1);
  controller.abort(new Error('Cancelled during metadata discovery')); f.backend.releaseCreate();
  await assert.rejects(launching, /Cancelled during metadata discovery/);
  assert.equal(prepare.mock.callCount(), 0); f.noAgentWork();
});

test('called definition changes during metadata discovery require a new preflight', async t => {
  const f = await fixture(t);
  const child = { ...definition, id: 'child' };
  f.store.saveDefinition(child);
  f.backend.holdCreate = true;
  const create = t.mock.method(f.backend, 'create');
  const checking = f.service.validateScheduledAgents({ ...definition, steps: [call(child)] }, {}, f.root);
  await until(() => create.mock.callCount() === 1);
  f.store.saveDefinition({ ...child, steps: [{ ...agent, model: 'missing' }] });
  f.backend.releaseCreate();
  await assert.rejects(checking, /no longer available/); f.noAgentWork();
});

test('pure code/MCP manifests do not probe any Backend', async t => {
  const f = await fixture(t);
  const child: WorkflowDefinition = { ...definition, id: 'child', steps: [{ id: 'shell', name: 'Shell', kind: 'shell', command: 'true' }] };
  f.store.saveDefinition(child);
  const graph: WorkflowDefinition = { ...definition, steps: [call(child), { id: 'mcp', name: 'MCP', kind: 'mcp', tool: { connectionId: 'local', connectionName: 'Local', identity: 'a'.repeat(64), serverIdentity: 'b'.repeat(64), toolName: 'read', inputSchema: { type: 'object' } } }] };
  await f.service.validateScheduledAgents(graph, {}, f.root);
  assert.equal(f.backend.sessions.length, 0); f.noAgentWork();
});
