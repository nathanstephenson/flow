import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { FakeBackend } from '../src/backend/fake/index.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import { fakeProvider } from './backend/sandbox-fixture.ts';
import { occurrenceId } from '../src/workflows/schedules.ts';

const definition: WorkflowDefinition = { version: 1, id: 'scheduled', name: 'Scheduled', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: 'printf success' }], edges: [] };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean, attempts = 300) { for (let i = 0; i < attempts; i++) { if (check()) return; await tick(); } assert.fail('Timed out'); }
async function fixture(t: import('node:test').TestContext, mode: 'none' | 'sandbox' = 'none') {
  let cleanup = async () => {}; t.after(() => cleanup());
  const f = fakeProvider(t);
  const state = f.stateRoot, root = f.scope;
  const config = new ConfigStore(state); config.update({ workflowRuntime: { nodePath: process.execPath }, filesystemIsolation: mode });
  const transcripts = new TranscriptStore(state), workflows = new WorkflowStore(state), backend = new FakeBackend();
  const host = new SessionHost({ store: transcripts, retention: 0, filesystemIsolationMode: () => mode, sandboxSupport: () => f.support, mcpConnections: config.mcpConnections }); host.registerBackend(backend);
  const runtime = join(state, 'runtime.cjs'); execFileSync(process.execPath, ['scripts/build-workflow-runtime.mjs', runtime]);
  const executions = new WorkflowExecutionService(host, workflows, new SecretStore(state), config, runtime);
  await host.load();
  cleanup = async () => { await executions.stopScheduled(); await host.shutdown(); };
  let attaches = 0;
  const id = occurrenceId('test', 1, 60_000);
  const launch = (graph = definition, occurrence = id, mcpConnectionIds: string[] = []) => executions.startScheduled({ occurrenceId: occurrence, definition: graph, input: {}, scope: root, projectId: root, mcpConnectionIds, attach: async () => { attaches++; return host.create({ scope: root, backend: 'fake', scheduled: { id: 'scheduled-parent', occurrenceId: occurrence } }); } });
  return { ...f, root, state, config, host, backend, workflows, executions, launch, id, agents: () => backend.sessions.filter(session => !session.toolless), attaches: () => attaches };
}
test('pure code success has no Agent/Backend Session, summary or session directory; history is occurrence-owned', async t => {
  const f = await fixture(t); const view = await f.launch();
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed'); assert.equal(result.version, 2); assert.equal(result.sessionId, undefined);
  assert.equal(f.host.list().length, 0); assert.equal(f.backend.sessions.length, 0); assert.equal(f.attaches(), 0);
  assert.ok(existsSync(join(f.state, 'workflow-schedules', 'executions', f.id, 'workflows', result.id + '.json')));
});
test('parallel agents attach once, retain checkpoint ownership and use existing parent recovery and Spend routing', async t => {
  const f = await fixture(t);
  const agent = { id: 'a', name: 'A', kind: 'agent' as const, model: 'fake-1', effort: 'medium' as const, instructions: 'JSON', outputSchema: { type: 'string' as const } };
  const view = await f.launch({ ...definition, steps: [agent, { ...agent, id: 'b', name: 'B' }] });
  await until(() => f.agents()[0]?.workflowSubagents.length === 2);
  assert.equal(f.attaches(), 1); assert.equal(f.host.list().length, 1); assert.equal(f.agents().length, 1);
  assert.equal(f.backend.sessions.filter(session => session.toolless).length, 1);
  for (const agent of f.agents()[0]!.workflowSubagents) agent.complete('"done"');
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.sessionId, 'scheduled-parent'); assert.equal(f.executions.scheduler.occupied('scheduled-parent'), false);
  assert.equal(f.executions.list('scheduled-parent').executions[0]!.id, result.id);
  assert.equal(f.workflows.getExecution('scheduled-parent', result.id).occurrenceId, f.id);
});
test('preflight failure creates no session; execution failure promotes once for recovery', async t => {
  const f = await fixture(t);
  await assert.rejects(f.launch({ ...definition, projectId: '/nonexistent' })); assert.equal(f.attaches(), 0);
  const view = await f.launch({ ...definition, steps: [{ ...definition.steps[0]!, kind: 'shell', command: 'exit 1' }] });
  await until(() => f.host.list().length === 1);
  const result = f.executions.scheduler.get(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'recovery-required'); assert.equal(f.attaches(), 1);
  await f.executions.cancel(`occurrence-${f.id}`, result.id);
});
test('Sandbox code executes on a backend-free occurrence VM and cancellation cleans up the lease', async t => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs']);
  const f = await fixture(t, 'sandbox');
  const view = await f.launch();
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed'); assert.equal(f.backend.sessions.length, 0); assert.equal(f.attaches(), 0);
  await f.executions.stopScheduled(); assert.ok(f.calls().some(line => line.startsWith('remove ')));
});

test('unreached invalid agent model rejects launch with only a metadata Backend Session', async t => {
  const f = await fixture(t);
  await assert.rejects(f.launch({ ...definition, steps: [
    { id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'equals', path: [], value: { no: true } } },
    { id: 'agent', name: 'Unreached', kind: 'agent', model: 'unavailable', effort: 'high', instructions: 'Never run', outputSchema: { type: 'string' } },
  ], edges: [{ id: 'edge', from: 'branch', to: 'agent', outcome: 'true' }] }), /Agent model.*unavailable/);
  assert.equal(f.attaches(), 0); assert.equal(f.host.list().length, 0);
  assert.equal(f.backend.sessions.length, 1); assert.equal(f.backend.sessions[0]!.toolless, true);
  assert.deepEqual(f.backend.sessions[0]!.prompts, []);
  assert.deepEqual(f.workflows.listExecutions(`occurrence-${f.id}`), []);
});
for (const mode of ['none', 'sandbox'] as const) test(`backend-free ${mode} stdio MCP pins identity and schemas without a code runtime`, async t => {
  const f = await fixture(t, mode);
  const connection = { id: 'local', name: 'Local', enabledByDefault: true, transport: 'stdio' as const, command: process.execPath, args: ['--experimental-strip-types', join(process.cwd(), 'test/fixtures/mcp-server.ts')] };
  f.config.update({ mcp: [connection] });
  const client = await f.host.scheduledMcp(f.root, [connection.id], 'none');
  await client.open();
  const { snapshotTool } = await import('../src/daemon/workflow-mcp.ts');
  const tool = snapshotTool(connection, client.tools().find(tool => tool.definition.name === 'echo')!);
  await client.dispose();
  const view = await f.launch({ ...definition, steps: [{ id: 'call', name: 'Call', kind: 'mcp', tool, mapping: { kind: 'template', template: { kind: 'literal', value: { text: 'scheduled' } } } }] }, f.id, [connection.id]);
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed', JSON.stringify(result.steps));
  assert.equal(f.attaches(), 0); assert.equal(f.backend.sessions.length, 0); assert.ok(JSON.stringify(result.result).includes('scheduled'));
});

test('host scheduled attachment is idempotent across concurrent callers and keeps the intended identity', async t => {
  const f = await fixture(t);
  const options = { scope: f.root, backend: 'fake', scheduled: { id: 'intended', occurrenceId: f.id } };
  const [first, second] = await Promise.all([f.host.attachScheduled(options), f.host.attachScheduled(options)]);
  assert.equal(first, 'intended'); assert.equal(second, first); assert.equal(f.backend.sessions.length, 1);
  assert.equal(await f.host.attachScheduled(options), first); assert.equal(f.backend.sessions.length, 1);
  await assert.rejects(f.host.attachScheduled({ ...options, scheduled: { ...options.scheduled, occurrenceId: 'different' } }), /mismatch/);
});

test('independent occurrences retain definitions and do not share the manual slot', async t => {
  const f = await fixture(t);
  const slow = { ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell' as const, command: 'sleep 0.2; printf original' }] };
  const secondId = occurrenceId('test', 1, 120_000);
  const first = await f.launch(slow);
  const second = await f.launch(slow, secondId);
  slow.steps[0]!.command = 'printf changed';
  const results = await Promise.all([f.executions.scheduler.wait(`occurrence-${f.id}`, first.execution.id), f.executions.scheduler.wait(`occurrence-${secondId}`, second.execution.id)]);
  for (const record of results) {
    assert.equal(record.status, 'completed'); assert.ok(JSON.stringify(record.result).includes('original'));
    assert.equal(record.sessionId, undefined);
  }
  assert.equal(f.attaches(), 0);
});

test('failed attachment retains sessionless recovery without an automatic creation retry', async t => {
  const f = await fixture(t); let calls = 0;
  const view = await f.executions.startScheduled({ occurrenceId: f.id, definition: { ...definition, steps: [{ id: 'fail', name: 'Fail', kind: 'shell', command: 'exit 1' }] }, input: {}, scope: f.root, projectId: f.root, mcpConnectionIds: [], attach: async () => { calls++; throw new Error('unavailable'); } });
  await until(() => calls === 1);
  await tick(); await tick();
  assert.equal(f.executions.scheduler.get(`occurrence-${f.id}`, view.execution.id).status, 'recovery-required');
  assert.equal(f.host.list().length, 0); assert.equal(calls, 1);
  await f.executions.cancel(`occurrence-${f.id}`, view.execution.id);
});

test('worktree occurrence uses a local base, adopts it on attachment and preserves dirty terminal cleanup', async t => {
  const f = await fixture(t);
  const { writeFileSync } = await import('node:fs');
  const { WorkflowScheduleStore } = await import('../src/workflows/schedule-store.ts');
  const { scheduleDriver } = await import('../src/daemon/workflow-schedule-driver.ts');
  const { createSchedule, occurrenceSettings } = await import('../src/workflows/schedules.ts');
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(f.root, 'tracked'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  writeFileSync(join(f.root, 'tracked'), 'uncommitted source');
  f.config.update({ projects: { include: [f.root] } });
  const workflows = f.workflows, schedules = new WorkflowScheduleStore(f.state), transcripts = new TranscriptStore(f.state);
  workflows.saveDefinition({ ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: 'cat tracked; printf dirty > new-file' }] });
  const driver = scheduleDriver({ host: f.host, config: f.config, workflows, executions: f.executions, schedules, transcripts });
  const settings = { name: 'Worktree', workflowId: definition.id, input: {}, projectId: f.root, mcpConnectionIds: [], timing: { kind: 'interval' as const, value: 1, unit: 'minutes' as const }, concurrency: 3, worktree: { from: 'main' } };
  const schedule = createSchedule(settings, 0, true); schedules.saveSchedule(schedule);
  const occurrence = { version: 1 as const, id: occurrenceId(schedule.id, 1, 60_000), scheduleId: schedule.id, activation: 1, revision: 1, scheduledAt: 60_000, createdAt: 60_000, settings: occurrenceSettings(schedule), status: 'provisioning' as const };
  schedules.claimOccurrence(occurrence);
  await driver.launch(occurrence);
  const saved = schedules.getOccurrence(occurrence.id);
  const result = await f.executions.scheduler.wait(`occurrence-${saved.id}`, saved.executionId!);
  assert.equal(result.status, 'completed'); assert.ok(JSON.stringify(result.result).includes('base')); assert.ok(!JSON.stringify(result.result).includes('uncommitted source'));
  assert.equal(f.host.list().length, 0);
  await driver.cleanup(saved);
  assert.ok(existsSync(saved.worktree!.path)); assert.equal(schedules.cleanupWarnings().length, 1);
  // A second launch with an agent adopts the already-provisioned Worktree rather than cutting again.
  const agent = { id: 'agent', name: 'Agent', kind: 'agent' as const, model: 'fake-1', effort: 'medium' as const, instructions: 'JSON', outputSchema: { type: 'string' as const } };
  workflows.saveDefinition({ ...definition, steps: [agent] });
  const second = { ...occurrence, id: occurrenceId(schedule.id, 1, 120_000), scheduledAt: 120_000, createdAt: 120_000 };
  schedules.claimOccurrence(second); await driver.launch(second);
  await until(() => f.agents()[0]?.workflowSubagents.length === 1);
  const attached = schedules.getOccurrence(second.id), meta = transcripts.readMeta(attached.sessionId!);
  assert.equal(meta?.scope, attached.scope); assert.deepEqual(meta?.worktree, attached.worktree); assert.equal(meta?.scheduledOccurrenceId, second.id);
  assert.equal(git('worktree', 'list', '--porcelain').split('worktree ').length - 1, 3);
  f.agents()[0]!.workflowSubagents[0]!.complete('"done"');
  await f.executions.scheduler.wait(`occurrence-${second.id}`, schedules.getOccurrence(second.id).executionId!);
});

test('unavailable captured Sandbox fails closed before any Backend Session or checkpoint starts', async t => {
  const f = await fixture(t, 'sandbox');
  t.mock.method(f.host, 'sandboxSupport', () => undefined);
  await assert.rejects(f.launch(), /Sandbox|sandbox/i);
  assert.equal(f.backend.sessions.length, 0); assert.equal(f.attaches(), 0);
  assert.equal(f.workflows.listExecutions(`occurrence-${f.id}`).length, 0);
});

test('called workflow agents promote the root occurrence without changing nested checkpoint identity', async t => {
  const f = await fixture(t);
  const { deriveResultSchema } = await import('../src/workflows/calls.ts');
  const child: WorkflowDefinition = { ...definition, id: 'child', steps: [{ id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'JSON', outputSchema: { type: 'string' } }] };
  f.workflows.saveDefinition(child);
  const root: WorkflowDefinition = { ...definition, steps: [{ id: 'call', name: 'Call', kind: 'workflow', workflowId: child.id, contract: { inputSchema: child.inputSchema, outputSchema: deriveResultSchema(child) } }] };
  const view = await f.launch(root);
  await until(() => f.agents()[0]?.workflowSubagents.length === 1);
  assert.equal(f.attaches(), 1);
  f.agents()[0]!.workflowSubagents[0]!.complete('"nested"');
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed'); assert.equal(result.sessionId, 'scheduled-parent');
  assert.equal(Object.values(result.invocations!).length, 1);
  assert.ok(JSON.stringify(result.result).includes('nested'));
  assert.equal(f.workflows.getExecution(`occurrence-${f.id}`, result.id).id, view.execution.id);
});

test('direct MCP Ask attaches once before human relay and uses the existing permission answer contract', async t => {
  const f = await fixture(t);
  const connection = { id: 'local', name: 'Local', enabledByDefault: true, transport: 'stdio' as const, command: process.execPath, args: ['--experimental-strip-types', join(process.cwd(), 'test/fixtures/mcp-server.ts')] };
  f.config.update({ mcp: [connection] });
  const client = await f.host.scheduledMcp(f.root, ['local'], 'none'); await client.open();
  const { snapshotTool } = await import('../src/daemon/workflow-mcp.ts');
  const tool = snapshotTool(connection, client.tools().find(tool => tool.definition.name === 'echo')!); await client.dispose();
  const view = await f.launch({ ...definition, steps: [{ id: 'call', name: 'Call', kind: 'mcp', permission: 'ask', tool, mapping: { kind: 'template', template: { kind: 'literal', value: { text: 'authorised' } } } }] }, f.id, ['local']);
  await until(() => f.executions.view(`occurrence-${f.id}`, view.execution.id).permissions.length === 1);
  assert.equal(f.attaches(), 1); assert.equal(f.host.list().length, 1);
  const permission = f.executions.view('scheduled-parent', view.execution.id).permissions[0]!;
  assert.equal(permission.direct, true);
  assert.equal((await f.executions.answer('scheduled-parent', view.execution.id, { subagentId: permission.subagentId, callId: permission.callId, decision: 'allow' })).accepted, true);
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed'); assert.ok(JSON.stringify(result.result).includes('authorised'));
});

test('shared Sandbox occurrences retain separate ownership while sharing one explicitly mounted VM', async t => {
  let cleanupShared = async () => {}; t.after(() => cleanupShared());
  const f = await fixture(t, 'sandbox');
  const { SharedSandbox } = await import('../src/isolation/shared-sandbox.ts');
  const shared = new SharedSandbox(f.state, () => f.root);
  t.mock.method(f.host, 'sharedSandbox', () => shared);
  cleanupShared = async () => { await f.executions.stopScheduled(); await shared.close(); };
  const graph = { ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell' as const, command: 'sleep 0.1; printf shared' }] };
  const id = occurrenceId('test', 1, 120_000);
  const [first, second] = await Promise.all([f.launch(graph), f.launch(graph, id)]);
  const results = await Promise.all([f.executions.scheduler.wait(`occurrence-${f.id}`, first.execution.id), f.executions.scheduler.wait(`occurrence-${id}`, second.execution.id)]);
  assert.ok(results.every(result => result.status === 'completed'));
  assert.equal(f.calls().filter(line => line === 'create').length, 1);
  assert.ok(f.spec().additionalWorkspaces.some(mount => mount.path === join(f.state, 'workflow-schedules', 'executions') && !mount.readOnly));
  assert.equal(f.attaches(), 0);
});

for (const handler of ['shell', 'mcp'] as const) test(`scheduled Sandbox ${handler} timeout handler retains the environment during child recovery`, async t => {
  const f = await fixture(t, 'sandbox');
  const { deriveResultSchema } = await import('../src/workflows/calls.ts');
  const child: WorkflowDefinition = { ...definition, id: 'child', steps: [{ id: 'fail', name: 'Fail', kind: 'shell', command: 'exit 1' }] };
  f.workflows.saveDefinition(child);
  let step: WorkflowDefinition['steps'][number] = { id: 'handler', name: 'Handler', kind: 'shell', command: 'printf handled' };
  const connections: string[] = [];
  if (handler === 'mcp') {
    const connection = { id: 'local', name: 'Local', enabledByDefault: true, transport: 'stdio' as const, command: process.execPath, args: ['--experimental-strip-types', join(process.cwd(), 'test/fixtures/mcp-server.ts')] };
    f.config.update({ mcp: [connection] }); connections.push(connection.id);
    const client = await f.host.scheduledMcp(f.root, connections, 'none'); await client.open();
    const { snapshotTool } = await import('../src/daemon/workflow-mcp.ts');
    const tool = snapshotTool(connection, client.tools().find(tool => tool.definition.name === 'echo')!); await client.dispose();
    step = { id: 'handler', name: 'Handler', kind: 'mcp', tool, mapping: { kind: 'template', template: { kind: 'literal', value: { text: 'handled' } } } };
  }
  const view = await f.launch({ ...definition, steps: [{ id: 'call', name: 'Call', kind: 'workflow', workflowId: child.id, timeoutMs: 10_000, contract: { inputSchema: child.inputSchema, outputSchema: deriveResultSchema(child) } }, step], edges: [{ id: 'timeout', from: 'call', to: 'handler', outcome: 'timeout' }] }, f.id, connections);
  const owner = `occurrence-${f.id}`;
  assert.equal((await f.executions.scheduler.wait(owner, view.execution.id)).status, 'recovery-required');
  await until(() => f.attaches() === 1);
  await until(() => f.executions.scheduler.get(owner, view.execution.id).sessionId === 'scheduled-parent');
  await assert.rejects(f.executions.recover('scheduled-parent', view.execution.id, { kind: 'retry', stepId: 'call' }, { revision: 'stale', authorized: false }));
  await assert.rejects(f.executions.recover('scheduled-parent', view.execution.id, { kind: 'retry', stepId: 'missing' }));
  await until(() => f.executions.scheduler.get(owner, view.execution.id).steps.handler!.status === 'completed', 2000);
  const result = await f.executions.scheduler.wait(owner, view.execution.id);
  assert.equal(result.status, 'completed-with-recovery', JSON.stringify(result.steps));
  assert.ok(JSON.stringify(result.result).includes('handled'));
  assert.equal(f.attaches(), 1);
});

test('shutdown drains recovery attachment and result publication before disposing late Backend Sessions', async t => {
  const f = await fixture(t);
  f.backend.holdCreate = true;
  t.after(() => f.backend.releaseCreate());
  let attaching = false;
  const view = await f.executions.startScheduled({ occurrenceId: f.id, definition: { ...definition, steps: [{ id: 'slow', name: 'Slow', kind: 'shell', command: 'sleep 30' }] }, input: {}, scope: f.root, projectId: f.root, mcpConnectionIds: [], attach: () => {
    attaching = true;
    return f.host.attachScheduled({ scope: f.root, backend: 'fake', scheduled: { id: 'delayed', occurrenceId: f.id } });
  } });
  let stopped = false;
  const stop = f.executions.stopScheduled().then(() => { stopped = true; });
  await until(() => attaching);
  await tick(); assert.equal(stopped, false);
  let shutdown = false;
  const closing = f.host.shutdown().then(() => { shutdown = true; });
  await tick(); assert.equal(shutdown, false);
  f.backend.releaseCreate();
  await Promise.all([stop, closing]);
  assert.equal(f.backend.sessions.length, 1);
  assert.equal(f.backend.latest.disposed, true);
  assert.equal(f.executions.scheduler.get(`occurrence-${f.id}`, view.execution.id).status, 'recovery-required');
  await assert.rejects(f.host.attachScheduled({ scope: f.root, backend: 'fake', scheduled: { id: 'late', occurrenceId: f.id } }), /stopping/);
});

test('named-secret literals in root and retained called definitions fail before a checkpoint or attachment', async t => {
  const f = await fixture(t);
  const secret = 'named-secret-that-must-not-be-persisted';
  new SecretStore(f.state).set('TOKEN', secret);
  const child: WorkflowDefinition = { ...definition, id: 'secret-child', name: secret, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: 'true', secrets: { token: 'TOKEN' } }] };
  await assert.rejects(f.launch(child));
  f.workflows.saveDefinition(child);
  const { deriveResultSchema } = await import('../src/workflows/calls.ts');
  await assert.rejects(f.launch({ ...definition, steps: [{ id: 'call', name: 'Call', kind: 'workflow', workflowId: child.id, contract: { inputSchema: child.inputSchema, outputSchema: deriveResultSchema(child) } }] }));
  assert.deepEqual(f.workflows.listExecutions(`occurrence-${f.id}`), []);
  assert.equal(f.attaches(), 0);
});

test('a schedule-created Shared Sandbox supports real WorkerBackend attachment without VM replacement', async t => {
  const f = await fixture(t, 'sandbox');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { SharedSandbox } = await import('../src/isolation/shared-sandbox.ts');
  const { WorkerBackend } = await import('../src/backend/worker/index.ts');
  const { WorkflowEnvironment } = await import('../src/daemon/workflow-environment.ts');
  const shared = new SharedSandbox(f.state, () => f.root);
  t.mock.method(f.host, 'sharedSandbox', () => shared);
  const resources = join(f.state, 'external-pi-resources'); mkdirSync(join(resources, 'skills'), { recursive: true });
  writeFileSync(join(resources, 'AGENTS.md'), 'resource');
  const auth = join(f.state, 'claude-auth'); mkdirSync(auth); f.support.provider.claudeAuthDir = auth;
  const backend = new WorkerBackend({ backendModule: new URL('./backend/worker-fixture.ts', import.meta.url).href, env: { PI_CODING_AGENT_DIR: resources }, stateRoot: f.state, sandbox: () => f.support, sharedSandbox: () => shared, isolationMode: () => 'sandbox' });
  f.host.registerBackend(backend);
  const environment = new WorkflowEnvironment(f.host, `occurrence-${f.id}`, f.root, [], 'sandbox', f.workflows.ownerPath(`occurrence-${f.id}`));
  let session: Awaited<ReturnType<typeof backend.create>> | undefined;
  try {
    const vm = await environment.vm();
    const stateDir = join(f.state, 'sessions', 'promoted', 'backend'); mkdirSync(stateDir, { recursive: true });
    session = await backend.create({ scope: f.root, stateDir, emit() {} });
    assert.equal(session.sandbox, vm);
    await session.prompt('permission-mode');
    assert.equal(f.calls().filter(call => call === 'create').length, 1);
    assert.ok(f.spec().additionalWorkspaces.some(mount => mount.path === auth && !mount.readOnly));
    assert.ok(f.spec().additionalWorkspaces.some(mount => mount.path === join(resources, 'skills') && mount.readOnly));
  } finally { await session?.dispose(); await environment.close(); await shared.close(); }
});

test('pre-checkpoint Sandbox ownership is reclaimed on reconciliation and retained on failed pruning', async t => {
  const f = await fixture(t, 'sandbox');
  const { WorkflowScheduleStore } = await import('../src/workflows/schedule-store.ts');
  const { scheduleDriver } = await import('../src/daemon/workflow-schedule-driver.ts');
  const { createSandbox } = await import('../src/isolation/sandbox.ts');
  const { mkdirSync } = await import('node:fs');
  const schedules = new WorkflowScheduleStore(f.state);
  const driver = scheduleDriver({ host: f.host, config: f.config, workflows: f.workflows, executions: f.executions, schedules, transcripts: new TranscriptStore(f.state) });
  const directory = f.workflows.ownerPath(`occurrence-${f.id}`); mkdirSync(directory, { recursive: true });
  const path = join(directory, 'sandbox.json');
  const occurrence = { version: 1 as const, id: f.id, scheduleId: 'test', activation: 1, revision: 1, scheduledAt: 60_000, createdAt: 60_000, status: 'provisioning' as const, settings: { name: 'Test', workflowId: definition.id, input: {}, projectId: f.root, mcpConnectionIds: [], timing: { kind: 'interval' as const, value: 1, unit: 'minutes' as const }, concurrency: 3 } };
  schedules.claimOccurrence(occurrence);
  await createSandbox(f.support.provider, { name: `flow-occurrence-${f.id}`, workspace: f.root, mounts: [], env: {} }, path);
  // Drop the in-memory handle, as a process crash would.
  const remove = f.support.provider.remove; f.support.provider.remove = ['/bin/false', '{name}'];
  await assert.rejects(driver.reconcile(occurrence)); assert.ok(existsSync(path));
  await assert.rejects(driver.cleanup(occurrence)); assert.ok(existsSync(path));
  f.support.provider.remove = remove;
  await driver.reconcile(occurrence);
  assert.equal(schedules.getOccurrence(f.id).status, 'interrupted');
  assert.equal(existsSync(path), false);
  assert.ok(f.calls().includes(`remove flow-occurrence-${f.id}`));
});

test('ordinary Revive uses current policy after scheduled work ends, without changing its captured runtime', async t => {
  const f = await fixture(t);
  const create = t.mock.method(f.backend, 'create');
  const view = await f.launch({ ...definition, steps: [{ id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'JSON', outputSchema: { type: 'string' } }] });
  await until(() => f.agents()[0]?.workflowSubagents.length === 1);
  f.agents()[0]!.workflowSubagents[0]!.complete('"done"');
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.runtime?.isolationMode, 'none');
  assert.equal(create.mock.calls.find(call => call.arguments[0].tools !== 'none')!.arguments[0].isolationMode, 'none');
  t.mock.method(f.host, 'filesystemIsolationMode', () => 'bubblewrap');
  await f.host.settle('scheduled-parent');
  await f.host.revive('scheduled-parent');
  assert.equal(create.mock.calls.at(-1)!.arguments[0].isolationMode, 'bubblewrap');
  assert.equal(f.workflows.getExecution(`occurrence-${f.id}`, result.id).runtime?.isolationMode, 'none');
});

test('scheduled attachment uses current unrestricted Settings while code retains its captured Sandbox', async t => {
  const f = await fixture(t, 'sandbox');
  const { writeFileSync } = await import('node:fs');
  const create = t.mock.method(f.backend, 'create');
  const view = await f.launch({ ...definition, steps: [
    { id: 'code', name: 'Code', kind: 'shell', command: 'while [ ! -f release ]; do sleep 0.01; done; printf captured' },
    { id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'JSON', outputSchema: { type: 'string' } },
  ], edges: [{ id: 'next', from: 'code', to: 'agent', outcome: 'success' }] });
  f.config.update({ filesystemIsolation: 'none' });
  t.mock.method(f.host, 'filesystemIsolationMode', () => 'none');
  writeFileSync(join(f.root, 'release'), 'ready');
  await until(() => f.agents()[0]?.workflowSubagents.length === 1);
  assert.equal(create.mock.calls.find(call => call.arguments[0].tools !== 'none')!.arguments[0].isolationMode, 'none');
  const meta = new TranscriptStore(f.state).readMeta('scheduled-parent')!;
  assert.equal(Object.hasOwn(meta, 'capturedIsolationMode'), false);
  f.agents()[0]!.workflowSubagents[0]!.complete('"done"');
  const result = await f.executions.scheduler.wait(`occurrence-${f.id}`, view.execution.id);
  assert.equal(result.status, 'completed'); assert.equal(result.runtime?.isolationMode, 'sandbox');
  assert.equal(f.calls().filter(call => call === 'create').length, 1);
});

test('idle scheduled recovery reuses its live Sandbox and accepts a validated retry', async t => {
  const f = await fixture(t, 'sandbox');
  const { writeFileSync } = await import('node:fs');
  const { recoveryRevision } = await import('../src/workflows/recovery.ts');
  const view = await f.launch({ ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: 'test -f ready && printf recovered' }] });
  const owner = `occurrence-${f.id}`;
  await f.executions.scheduler.wait(owner, view.execution.id);
  await until(() => !!f.executions.scheduler.get(owner, view.execution.id).sessionId);
  await tick();
  assert.equal(f.calls().filter(call => call.startsWith('remove ')).length, 0);
  writeFileSync(join(f.root, 'ready'), 'yes');
  const current = f.executions.scheduler.get(owner, view.execution.id);
  await f.executions.recover('scheduled-parent', current.id, { kind: 'retry', stepId: 'code' }, { revision: recoveryRevision(current), authorized: true });
  const result = await f.executions.scheduler.wait(owner, current.id);
  assert.equal(result.status, 'completed-with-recovery');
  assert.equal(f.calls().filter(call => call === 'create').length, 1);
});

async function scheduledDriverFixture(t: import('node:test').TestContext, mode: 'none' | 'sandbox' = 'none') {
  const f = await fixture(t, mode);
  const { WorkflowScheduleStore } = await import('../src/workflows/schedule-store.ts');
  const { WorkflowScheduleService } = await import('../src/daemon/workflow-schedules.ts');
  const { scheduleDriver } = await import('../src/daemon/workflow-schedule-driver.ts');
  f.config.update({ projects: { include: [f.root] } });
  const schedules = new WorkflowScheduleStore(f.state);
  const driver = scheduleDriver({ host: f.host, config: f.config, workflows: f.workflows, executions: f.executions, schedules, transcripts: new TranscriptStore(f.state) });
  let now = 0;
  const service = new WorkflowScheduleService(schedules, driver, () => now);
  f.executions.onScheduledResult = async record => { service.result(record); };
  t.after(() => service.stopAdmission());
  const settings: import('../src/protocol/workflow-schedules.ts').WorkflowScheduleSettings = { name: 'Test', workflowId: definition.id, input: {}, projectId: f.root, mcpConnectionIds: [], timing: { kind: 'interval' as const, value: 1, unit: 'minutes' as const }, concurrency: 1 };
  return { ...f, schedules, driver, service, settings, advance: (value: number) => { now = value; } };
}

test('post-checkpoint private persistence failure stops uncertain effects and retains occurrence recovery/capacity', async t => {
  const f = await scheduledDriverFixture(t);
  const marker = join(f.root, 'must-not-finish');
  f.workflows.saveDefinition({ ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: `sleep 1; touch '${marker}'` }] });
  // Fault the exact write after scheduler.start, not preflight/checkpoint persistence.
  const internal = f.executions as unknown as { savePrivate: (...args: unknown[]) => void };
  t.mock.method(internal, 'savePrivate', () => { throw new Error('disk unavailable'); });
  const schedule = await f.service.create(f.settings, true);
  await f.service.start(false); f.advance(60_000); await f.service.tick();
  await until(() => f.schedules.listOccurrences(schedule.id)[0]?.status === 'recovery-required');
  const saved = f.schedules.listOccurrences(schedule.id)[0]!;
  assert.ok(saved.executionId);
  assert.equal(f.executions.scheduler.get(`occurrence-${saved.id}`, saved.executionId!).status, 'recovery-required');
  assert.equal(f.service.hasActiveWork(), true);
  f.advance(120_000); await f.service.tick();
  assert.equal(f.schedules.listOccurrences(schedule.id).find(item => item.scheduledAt === 120_000)?.status, 'capacity-skipped');
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(existsSync(marker), false);
  await f.driver.reconcile(saved);
  assert.equal(f.schedules.getOccurrence(saved.id).executionId, saved.executionId);
  assert.equal(f.workflows.listExecutions(`occurrence-${saved.id}`).length, 1);
});

test('occurrence metadata failure after start retains checkpoint identity instead of launch-failed', async t => {
  const f = await scheduledDriverFixture(t);
  f.workflows.saveDefinition({ ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: 'sleep 30' }] });
  const save = f.schedules.saveOccurrence.bind(f.schedules); let failed = false;
  t.mock.method(f.schedules, 'saveOccurrence', (record: import('../src/protocol/workflow-schedules.ts').WorkflowOccurrence) => {
    if (!failed && record.status === 'running' && record.executionId) { failed = true; throw new Error('metadata unavailable'); }
    save(record);
  });
  const schedule = await f.service.create(f.settings, true);
  await f.service.start(false); f.advance(60_000); await f.service.tick();
  await until(() => failed && !!f.schedules.listOccurrences(schedule.id)[0]?.executionId);
  const saved = f.schedules.listOccurrences(schedule.id)[0]!;
  assert.equal(failed, true); assert.ok(saved.executionId); assert.equal(f.service.hasActiveWork(), true);
  assert.equal(saved.status, 'running');
  assert.equal(f.executions.scheduler.get(`occurrence-${saved.id}`, saved.executionId!).status, 'running');
  assert.equal(f.host.list().length, 0);
});

for (const kind of ['shell', 'mcp'] as const) test(`failed attachment retry preserves live Sandbox ${kind} deadline work and its environment`, async t => {
  const f = await scheduledDriverFixture(t, 'sandbox');
  const { deriveResultSchema } = await import('../src/workflows/calls.ts');
  const child: WorkflowDefinition = { ...definition, id: 'child', steps: [{ id: 'fail', name: 'Fail', kind: 'shell', command: 'exit 1' }] };
  f.workflows.saveDefinition(child);
  let handler: WorkflowDefinition['steps'][number] = { id: 'handler', name: 'Handler', kind: 'shell', command: 'printf handled' };
  if (kind === 'mcp') {
    const connection = { id: 'local', name: 'Local', enabledByDefault: true, transport: 'stdio' as const, command: process.execPath, args: ['--experimental-strip-types', join(process.cwd(), 'test/fixtures/mcp-server.ts')] };
    f.config.update({ mcp: [connection] }); f.settings.mcpConnectionIds.push(connection.id);
    const client = await f.host.scheduledMcp(f.root, [connection.id], 'none'); await client.open();
    const { snapshotTool } = await import('../src/daemon/workflow-mcp.ts');
    const tool = snapshotTool(connection, client.tools().find(tool => tool.definition.name === 'echo')!); await client.dispose();
    handler = { id: 'handler', name: 'Handler', kind: 'mcp', tool, mapping: { kind: 'template', template: { kind: 'literal', value: { text: 'handled' } } } };
  }
  f.workflows.saveDefinition({ ...definition, steps: [{ id: 'call', name: 'Call', kind: 'workflow', workflowId: child.id, timeoutMs: 3000, contract: { inputSchema: child.inputSchema, outputSchema: deriveResultSchema(child) } }, handler], edges: [{ id: 'timeout', from: 'call', to: 'handler', outcome: 'timeout' }] });
  const attach = f.host.attachScheduled.bind(f.host); let attempts = 0;
  t.mock.method(f.host, 'attachScheduled', (options: Parameters<typeof attach>[0]) => { if (++attempts === 1) return Promise.reject(new Error('backend unavailable')); return attach(options); });
  const schedule = await f.service.create(f.settings, true);
  await f.service.start(false); f.advance(60_000); await f.service.tick();
  await until(() => { const saved = f.schedules.listOccurrences(schedule.id)[0]; return saved?.association === 'failed' && !!saved.executionId; });
  const saved = f.schedules.listOccurrences(schedule.id)[0]!;
  const owner = `occurrence-${saved.id}`;
  assert.equal(f.executions.scheduler.hasPendingDeadline(owner, saved.executionId!), true);
  const resources = (f.executions as unknown as { resources: import('../src/daemon/workflow-execution-resources.ts').WorkflowExecutionResources }).resources;
  const environment = resources.occurrence(owner).environment;
  await f.service.retryAttachment(saved.id);
  assert.equal(resources.occurrence(owner).environment, environment);
  assert.equal(f.calls().filter(call => call.startsWith('remove ')).length, 0);
  assert.equal(attempts, 2);
  await until(() => f.executions.scheduler.get(owner, saved.executionId!).status === 'completed-with-recovery', 1000);
  const result = f.executions.scheduler.get(owner, saved.executionId!);
  assert.ok(JSON.stringify(result.result).includes('handled'));
  assert.equal(f.calls().filter(call => call === 'create').length, 1);
  assert.equal(f.backend.sessions.length, 1);
});

test('Settle → Reap → restart protects a recovery occurrence association and clean worktree until terminal', async t => {
  const f = await scheduledDriverFixture(t);
  const { writeFileSync } = await import('node:fs');
  const { scheduleDriver } = await import('../src/daemon/workflow-schedule-driver.ts');
  const { recoveryRevision } = await import('../src/workflows/recovery.ts');
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args]);
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  writeFileSync(join(f.root, 'tracked'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  // Fail without dirtying the worktree: ordinary Reap would otherwise remove it.
  f.workflows.saveDefinition({ ...definition, steps: [{ id: 'code', name: 'Code', kind: 'shell', command: 'exit 1' }] });
  const schedule = await f.service.create({ ...f.settings, worktree: { from: 'main' } }, true);
  await f.service.start(false); f.advance(60_000); await f.service.tick();
  await until(() => f.schedules.listOccurrences(schedule.id)[0]?.association === 'attached');
  const occurrence = f.schedules.listOccurrences(schedule.id)[0]!;
  const sessionId = occurrence.sessionId!;
  await f.host.settle(sessionId);
  // Force an expired retention policy without waiting.
  const restartingHost = new SessionHost({ store: new TranscriptStore(f.state), retention: 0, filesystemIsolationMode: () => 'none' });
  restartingHost.registerBackend(new FakeBackend());
  // First verify the live host's Reap with an expired retention policy, too.
  assert.deepEqual(await f.host.reap(Date.now() + 1000), []);
  assert.ok(existsSync(occurrence.worktree!.path));
  await f.executions.stopScheduled(); await f.host.shutdown();
  const workflows = new WorkflowStore(f.state);
  const executions = new WorkflowExecutionService(restartingHost, workflows, new SecretStore(f.state), f.config, join(f.state, 'runtime.cjs'));
  t.after(async () => { await executions.stopScheduled(); await restartingHost.shutdown(); });
  // load() itself runs Reap, before occurrence reconciliation.
  await restartingHost.load();
  assert.ok(restartingHost.list().some(session => session.id === sessionId));
  assert.ok(existsSync(occurrence.worktree!.path));
  const driver = scheduleDriver({ host: restartingHost, config: f.config, workflows, executions, schedules: f.schedules, transcripts: new TranscriptStore(f.state) });
  await driver.reconcile(f.schedules.getOccurrence(occurrence.id));
  assert.equal(f.schedules.getOccurrence(occurrence.id).association, 'attached');
  assert.equal(f.schedules.getOccurrence(occurrence.id).sessionId, sessionId);
  await restartingHost.revive(sessionId);
  const current = executions.scheduler.get(`occurrence-${occurrence.id}`, occurrence.executionId!);
  await executions.recover(sessionId, current.id, { kind: 'retry', stepId: 'code' }, { revision: recoveryRevision(current), authorized: true });
  await until(() => executions.scheduler.get(`occurrence-${occurrence.id}`, current.id).status === 'recovery-required');
  await executions.cancel(`occurrence-${occurrence.id}`, current.id);
  assert.equal(executions.canForget(sessionId), true);
  await restartingHost.settle(sessionId);
  assert.deepEqual(await restartingHost.reap(Date.now() + 1000), [sessionId]);
  assert.equal(existsSync(occurrence.worktree!.path), false);
  assert.ok(workflows.getExecution(`occurrence-${occurrence.id}`, current.id));
});
