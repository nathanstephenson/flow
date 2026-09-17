import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { serve } from '../src/daemon/server.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import type { WorkflowExecutionView } from '../src/protocol/workflow-executions.ts';
import { reduceAll } from '../src/client/reduce.ts';
import { WorkflowStepError } from '../src/workflows/scheduler.ts';

const runtimeDirectory = mkdtempSync(join(tmpdir(), 'flow-execution-runtime-'));
const runtimePath = join(runtimeDirectory, 'runtime.cjs');
before(() => execFileSync(process.execPath, ['scripts/build-workflow-runtime.mjs', runtimePath]));
after(() => rmSync(runtimeDirectory, { recursive: true, force: true }));

const definition: WorkflowDefinition = { version: 1, id: 'sample', name: 'Sample', backend: 'fake', permission: 'ask', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'Return JSON', outputSchema: { type: 'string' } }], edges: [] };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(); } assert.fail('Timed out'); }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flow-executions-'));
  const store = new TranscriptStore(root), workflows = new WorkflowStore(root), secrets = new SecretStore(root), config = new ConfigStore(root);
  config.update({ workflowRuntime: { externalSandbox: false, nodePath: process.execPath } });
  const backend = new FakeBackend();
  const host = new SessionHost({ store, retention: 0, allowTool: config.allowTool }); host.registerBackend(backend);
  const service = new WorkflowExecutionService(host, workflows, secrets, config, runtimePath);
  await host.load(); service.reconcile();
  const id = await host.create({ scope: root, backend: 'fake' });
  workflows.saveDefinition(definition);
  const server = await serve({ host, store, workflows, secrets, config, workflowExecutions: service, token: 'test', assets: {} });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(server.url + path, { method, headers: { authorization: 'Bearer test' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const base = `/api/sessions/${id}/workflows`;
  return { root, store, workflows, secrets, config, backend, host, service, id, request, base, async close() { await host.shutdown(); await server.close(); rmSync(root, { recursive: true, force: true }); } };
}

it('deduplicates concurrent ambiguous launches by their durable launch id', async () => {
  const f = await fixture();
  try {
    const body = { workflowId: definition.id, input: {}, launchId: 'retained-launch', nameSession: true };
    const [first, second] = await Promise.all([
      f.request(f.base, 'POST', body),
      f.request(f.base, 'POST', body),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json() as WorkflowExecutionView;
    const b = await second.json() as WorkflowExecutionView;
    assert.equal(b.execution.id, a.execution.id);
    assert.equal(f.service.list(f.id).executions.length, 1);
  } finally { await f.close(); }
});

it('accepts bounded extra-try guidance through HTTP and sends it to each owned Agent without changing the definition', async () => {
  const f = await fixture();
  try {
    const agent = { ...definition.steps[0]!, outputSchema: { type: 'number' as const } };
    const graph: WorkflowDefinition = {
      ...definition, loopSettings: { head: { maxTries: 1 } },
      steps: [{ id: 'root', name: 'Root', kind: 'join' }, { ...agent, id: 'head', name: 'Head' }, { id: 'check', name: 'Check', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } }, { ...agent, id: 'worker', name: 'Worker' }],
      edges: [{ id: 'entry', from: 'root', to: 'head', outcome: 'success' }, { id: 'check', from: 'head', to: 'check', outcome: 'success' }, { id: 'correct', from: 'check', to: 'worker', outcome: 'true' }, { id: 'back', from: 'worker', to: 'head', outcome: 'success' }],
    };
    const started = await f.service.start({ sessionId: f.id, definition: graph, input: {} });
    const path = `${f.base}/${started.execution.id}/recover`;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const spend = { type: 'spend' as const, spend: { tokens: 10, cached: 0, costUSD: 0.01, models: [] } };
    f.backend.latest.workflowSubagents[0]!.emit(spend);
    f.backend.latest.workflowSubagents[0]!.complete(1);
    const limit = await f.service.scheduler.wait(f.id, started.execution.id);
    assert.equal(limit.status, 'recovery-required');
    assert.equal(limit.steps.worker!.attempts.length, 0);
    const grant = { kind: 'extend-loop', headerId: 'head', activation: 1, try: 1, guidance: 'Check the missing case' };
    for (const guidance of [4, 'x'.repeat(100_001)]) assert.equal((await f.request(path, 'POST', { ...grant, guidance })).status, 400);
    for (const action of [{ kind: 'continue' }, { ...grant, activation: 2 }, { ...grant, try: 2 }]) assert.equal((await f.request(path, 'POST', action)).status, 409);
    assert.equal((await f.request(path, 'POST', grant)).status, 200);
    assert.equal((await f.request(path, 'POST', grant)).status, 409);
    await until(() => f.backend.latest.workflowSubagents.length === 2);
    const worker = f.backend.latest.workflowSubagents[1]!;
    assert.ok(worker.options.instructions.includes(grant.guidance));
    worker.emit(spend); worker.complete(1);
    await until(() => f.backend.latest.workflowSubagents.length === 3);
    const head = f.backend.latest.workflowSubagents[2]!;
    assert.ok(head.options.instructions.includes(grant.guidance));
    head.emit(spend); head.complete(0);
    const result = await f.service.scheduler.wait(f.id, started.execution.id);
    assert.equal(result.status, 'completed-with-recovery');
    assert.deepEqual(result.definition, graph);
    assert.equal(f.service.view(f.id, started.execution.id).spend?.tokens, 30);
    assert.equal(f.service.view(f.id, started.execution.id).stepSpend.head?.tokens, 20);
  } finally { await f.close(); }
});

for (const stop of ['shutdown', 'dispose'] as const) for (const recovery of [false, true]) {
  it(`refuses ${recovery ? 'recovery' : 'start'} after ${stop} completes during open`, async () => {
    const f = await fixture();
    try {
      let executionId = '';
      if (recovery) {
        const started = await f.service.start({ sessionId: f.id, definition, input: {} });
        executionId = started.execution.id;
        await until(() => f.backend.latest.workflowSubagents.length === 1);
        f.backend.latest.workflowSubagents[0]!.fail();
        await f.service.scheduler.wait(f.id, executionId);
      }
      const open = f.host.openWorkflowSession.bind(f.host);
      f.host.openWorkflowSession = async id => {
        const identity = await open(id);
        if (stop === 'shutdown') await f.host.shutdown(); else await f.host.dispose(id);
        return identity;
      };
      if (recovery) await assert.rejects(f.service.recover(f.id, executionId, { kind: 'retry', stepId: 'agent' }), /stopping|owned|ended/);
      else await assert.rejects(f.service.start({ sessionId: f.id, definition: { ...definition, steps: [{ id: 'shell', name: 'Shell', kind: 'shell', command: 'touch after-shutdown' }] }, input: {} }), /stopping|owned|ended/);
      assert.equal(existsSync(join(f.root, 'after-shutdown')), false);
      assert.equal(f.backend.latest.workflowSubagents.length, recovery ? 1 : 0);
    } finally { await f.close(); }
  });
}

for (const permission of ['auto-accept', 'ask'] as const) {
  it(`uses workflow handle permissions with parent permissions false: ${permission}`, async () => {
    const f = await fixture();
    try {
      f.backend.latest.capabilities.permissions = false;
      const graph: WorkflowDefinition = { ...definition, permission: 'auto-accept', steps: [{ ...definition.steps[0]!, ...(permission === 'ask' ? { permission } : {}) }] };
      const started = await f.service.start({ sessionId: f.id, definition: graph, input: {} });
      await until(() => f.backend.latest.workflowSubagents.length === 1);
      const handle = f.backend.latest.workflowSubagents[0]!;
      assert.equal(handle.options.permissionMode, permission);
      if (permission === 'ask') {
        handle.requestPermission('Bash');
        const callId = f.service.view(f.id, started.execution.id).permissions[0]!.callId;
        assert.equal(f.host.statusOf(f.id), 'idle');
        assert.equal(f.host.list().find(summary => summary.id === f.id)?.activeWorkflows, 1);
        assert.equal(f.service.view(f.id, started.execution.id).permissions.length, 1);
        await f.host.send(f.id, 'Chat while workflow permission is pending', 'now');
        assert.equal(f.backend.latest.prompts.at(-1), 'Chat while workflow permission is pending\n\n' + f.service.context(f.id));
        await f.service.answer(f.id, started.execution.id, { subagentId: handle.options.id, callId, decision: 'allow' });
        assert.equal(f.service.view(f.id, started.execution.id).permissions.length, 0);
      }
      handle.complete('ok');
      assert.equal((await f.service.scheduler.wait(f.id, started.execution.id)).result, 'ok');
    } finally { await f.close(); }
  });
}

it('ignores unrelated secrets and unselected step references', async () => {
  const f = await fixture();
  try {
    f.secrets.set('UNUSED', 'a');
    const graph: WorkflowDefinition = { ...definition, steps: [{ id: 'selected', name: 'Sample', kind: 'join' }, { ...definition.steps[0]!, secrets: { token: 'MISSING' } }], edges: [{ id: 'next', from: 'selected', to: 'agent', outcome: 'success' }] };
    const started = await f.service.start({ sessionId: f.id, definition: graph, input: {}, stepId: 'selected' });
    assert.equal((await f.service.scheduler.wait(f.id, started.execution.id)).status, 'completed');
    const response = await f.request(f.base, 'POST', { workflowId: definition.id, input: {}, nameSession: true });
    assert.equal(response.status, 200, 'automatic naming is non-blocking when no Summary Model is configured');
  } finally { await f.close(); }
});

it('rechecks changed named secret values on recovery and keeps references literal', async () => {
  const f = await fixture();
  try {
    f.secrets.set('KEY', 'KEY');
    const graph: WorkflowDefinition = { ...definition, steps: [{ ...definition.steps[0]!, secrets: { token: 'KEY' } }] };
    const started = await f.service.start({ sessionId: f.id, definition: graph, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.backend.latest.workflowSubagents[0]!.fail();
    await f.service.scheduler.wait(f.id, started.execution.id);
    f.secrets.set('KEY', 'changed-"quote\nline');
    await assert.rejects(f.service.recover(f.id, started.execution.id, { kind: 'supply', stepId: 'agent', output: 'changed-"quote\nline' }), /secret values/);
    await f.service.recover(f.id, started.execution.id, { kind: 'retry', stepId: 'agent' });
    await until(() => f.backend.latest.workflowSubagents.length === 2);
    f.backend.latest.workflowSubagents[1]!.complete('changed-"quote\nline');
    const result = await f.service.scheduler.wait(f.id, started.execution.id);
    assert.equal(result.result, '[REDACTED]');
    assert.equal(result.definition.steps[0]!.secrets?.token, 'KEY');
  } finally { await f.close(); }
});

it('returns graph and capability reasons without submitted Zod values', async () => {
  const f = await fixture();
  try {
    for (const [graph, message] of [
      [{ ...definition, edges: [{ id: 'bad', from: 'missing', to: 'agent', outcome: 'success' }] }, 'Unknown edge endpoint'],
      [{ ...definition, steps: [{ ...definition.steps[0]!, model: 'missing' }] }, 'Agent model is unavailable'],
      [{ ...definition, permission: 'submitted-credential' }, 'Invalid workflow request'],
    ] as const) {
      const response = await f.request('/api/workflows/test', 'POST', { definition: graph, sessionId: f.id, stepId: 'agent', input: {} });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: message });
    }
  } finally { await f.close(); }
});

it('preserves safe structured partial output from Workflow Step errors', async () => {
  const f = await fixture();
  try {
    f.secrets.set('KEY', 'private-partial');
    const open = f.backend.latest.startWorkflowSubagent.bind(f.backend.latest);
    f.backend.latest.startWorkflowSubagent = options => {
      const handle = open(options);
      void handle.done.catch(() => {});
      Object.defineProperty(handle, 'done', { value: Promise.reject(new WorkflowStepError('Missing build manifest: private-partial', { detail: 'private-partial', count: 2 })) });
      return handle;
    };
    const started = await f.service.start({ sessionId: f.id, definition: { ...definition, steps: [{ ...definition.steps[0]!, secrets: { token: 'KEY' } }] }, input: {} });
    const result = await f.service.scheduler.wait(f.id, started.execution.id);
    const attempt = result.steps.agent!.attempts[0]!;
    assert.equal(attempt.error?.message, 'Missing build manifest: [REDACTED]');
    assert.deepEqual(attempt.partialOutput, { detail: '[REDACTED]', count: 2 });
  } finally { await f.close(); }
});

it('preserves useful TypeScript failures and redacts JSON-escaped secrets', async () => {
  const f = await fixture();
  try {
    f.secrets.set('KEY', 'private-"quote\nline');
    for (const code of ['throw new Error("Missing required build manifest")', 'throw new Error("Build failed: " + JSON.stringify(secrets.token))']) {
      const graph: WorkflowDefinition = { ...definition, steps: [{ id: 'code', name: 'Code', kind: 'typescript', code, secrets: { token: 'KEY' }, outputSchema: { type: 'string' } }] };
      const started = await f.service.start({ sessionId: f.id, definition: graph, input: {} });
      const result = await f.service.scheduler.wait(f.id, started.execution.id);
      const text = JSON.stringify(result);
      assert.ok(text.includes(code.includes('Missing') ? 'Missing required build manifest' : 'Build failed:'));
      assert.ok(!text.includes('private-'));
      await f.service.cancel(f.id, started.execution.id);
    }
  } finally { await f.close(); }
});

it('runs an owned Agent beside chat, keeps requests private, rejects stale decisions, records result and Spend once', async () => {
  const f = await fixture();
  try {
    await f.host.send(f.id, 'parent chat', 'now');
    const response = await f.request(f.base, 'POST', { workflowId: 'sample', input: {} });
    assert.equal(response.status, 200);
    const started = await response.json() as WorkflowExecutionView;
    const path = f.base + '/' + started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    assert.equal(f.host.statusOf(f.id), 'running');
    assert.equal(f.host.list().find(summary => summary.id === f.id)?.activeWorkflows, 1);
    assert.equal((await f.request(f.base, 'POST', { workflowId: 'sample', input: {} })).status, 409);
    assert.equal(f.backend.latest.prompts.length, 1);
    const questions = [{ header: 'Pick', question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
    handle.ask(questions, 'raw-ask');
    handle.requestPermission('Bash', 'raw-call');
    const askId = f.service.view(f.id, started.execution.id).enquiries[0]!.askId;
    const callId = f.service.view(f.id, started.execution.id).permissions[0]!.callId;
    let view = await (await f.request(path)).json() as WorkflowExecutionView;
    assert.equal(view.enquiries[0]?.askId, askId); assert.equal(view.permissions[0]?.callId, callId);
    assert.ok(!JSON.stringify(f.host.logFor(f.id).since(0)).includes('raw-ask'));
    assert.equal((await f.request(path + '/enquiry', 'POST', { subagentId: handle.options.id, askId, answers: [['A']] })).status, 404, 'workflow answers have no direct HTTP route');
    assert.equal((await f.request(path + '/permission', 'POST', { subagentId: handle.options.id, callId, decision: 'always' })).status, 404, 'workflow decisions have no direct HTTP route');
    await f.service.answer(f.id, started.execution.id, { subagentId: handle.options.id, askId, answers: [['A']] });
    await assert.rejects(f.service.answer(f.id, started.execution.id, { subagentId: handle.options.id, askId, answers: [['A']] }), /no longer available/);
    await assert.rejects(f.service.answer(f.id, started.execution.id, { subagentId: 'stale', callId, decision: 'always' }), /no longer available/);
    assert.deepEqual(f.config.standingAuthorisations(), []);
    await f.service.answer(f.id, started.execution.id, { subagentId: handle.options.id, callId, decision: 'always' });
    assert.deepEqual(f.config.standingAuthorisations(), ['Bash']);
    handle.emit({ type: 'spend', spend: { tokens: 12, cached: 2, costUSD: 0.01, models: [] } });
    handle.complete('result');
    await f.service.scheduler.wait(f.id, started.execution.id); await pause();
    view = await (await f.request(path)).json() as WorkflowExecutionView;
    assert.equal(view.execution.result, 'result'); assert.equal(view.spend?.tokens, 12);
    assert.equal(view.enquiries.length, 0);
    assert.equal(f.host.list().find(summary => summary.id === f.id)?.activeWorkflows, 0);
    assert.equal(f.backend.latest.prompts.length, 1, 'completion waits for the current parent turn');
    f.backend.latest.completeTurn();
    await until(() => f.backend.latest.prompts.length === 2);
    const completion = f.backend.latest.prompts[1]!;
    assert.ok(completion.includes(started.execution.id));
    assert.ok(completion.includes('Exact structured final output:\n"result"'));
    f.service.reconcile(); f.service.reconcile();
    assert.equal(f.backend.latest.prompts.length, 2, 'completion is announced once');
    assert.equal(f.host.logFor(f.id).since(0).filter(({ event }) => event.type === 'notice' && event.text === 'Workflow completed. The parent is preparing the result.').length, 1);
    assert.equal(reduceAll(f.host.logFor(f.id).since(0)).spend?.tokens, 12);
    f.backend.latest.reportSpend({ tokens: 100, cached: 20, costUSD: 1, models: [] });
    f.backend.latest.reportSpend({ tokens: 100, cached: 20, costUSD: 1, models: [] });
    const state = reduceAll(f.host.logFor(f.id).since(0));
    assert.equal(state.contextUsage?.spend?.tokens, 112);
    assert.equal(state.contextUsage?.used, 10);
    assert.equal(f.backend.latest.prompts.length, 2);
  } finally { await f.close(); }
});

it('tests only the selected step, validates model/backend/Project, and keeps fixed definitions through recovery and deletion', async () => {
  const f = await fixture();
  try {
    for (const bad of [{ ...definition, backend: 'pi' }, { ...definition, projectId: f.root + '/child' }, { ...definition, steps: [{ ...definition.steps[0]!, model: 'absent' }] }]) {
      assert.equal((await f.request('/api/workflows/test', 'POST', { definition: bad, sessionId: f.id, stepId: 'agent', input: {} })).status, 400);
    }
    const graph = { ...definition, steps: [...definition.steps, { id: 'later', name: 'Later', kind: 'join' }], edges: [{ id: 'next', from: 'agent', to: 'later', outcome: 'success' }] };
    const started = await (await f.request('/api/workflows/test', 'POST', { definition: graph, sessionId: f.id, stepId: 'agent', input: {} })).json() as WorkflowExecutionView;
    const path = f.base + '/' + started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.workflows.deleteDefinition(definition.id);
    f.backend.latest.workflowSubagents[0]!.fail();
    await f.service.scheduler.wait(f.id, started.execution.id);
    assert.equal((await f.request(path + '/recover', 'POST', { kind: 'supply', stepId: 'agent', output: 4 })).status, 400);
    assert.equal((await f.request(path + '/recover', 'POST', { kind: 'supply', stepId: 'agent', output: 'supplied' })).status, 200);
    const view = await (await f.request(path)).json() as WorkflowExecutionView;
    assert.equal(view.execution.status, 'completed-with-recovery');
    assert.equal(view.execution.steps.later?.status, 'skipped');
    assert.equal(f.backend.latest.prompts.length, 0, 'step tests never notify the parent');
    await f.host.settle(f.id); await f.host.reap(Date.now() + 10);
    assert.equal(existsSync(join(f.root, 'sessions', f.id)), false);
    assert.equal(f.service.scheduler.occupied(f.id), false);
  } finally { await f.close(); }
});

it('interrupts on shutdown, recovers a deleted saved definition without replay, and deduplicates after restart', async () => {
  const f = await fixture();
  let other: SessionHost | undefined;
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.backend.latest.workflowSubagents[0]!.emit({ type: 'notice', level: 'info', text: 'private before restart' });
    await f.host.shutdown();
    assert.equal(f.service.view(f.id, started.execution.id).execution.status, 'recovery-required');
    f.workflows.deleteDefinition(definition.id);
    other = new SessionHost({ store: f.store }); const backend = new FakeBackend(); other.registerBackend(backend);
    const service = new WorkflowExecutionService(other, f.workflows, f.secrets, f.config, runtimePath);
    await other.load(); service.reconcile();
    assert.equal(other.statusOf(f.id), 'dormant');
    assert.equal(service.view(f.id, started.execution.id).activity.length, 1);
    assert.equal(service.scheduler.occupied(f.id), true);
    await service.recover(f.id, started.execution.id, { kind: 'retry', stepId: 'agent' });
    await until(() => backend.latest.workflowSubagents.length === 1);
    assert.equal(backend.latest.prompts.length, 0);
    backend.latest.workflowSubagents[0]!.complete('after restart');
    await service.scheduler.wait(f.id, started.execution.id);
    await until(() => backend.latest.prompts.length === 1);
    assert.ok(backend.latest.prompts[0]!.includes('after restart'));
    await other.shutdown();
    const finalHost = new SessionHost({ store: f.store });
    const finalBackend = new FakeBackend();
    finalHost.registerBackend(finalBackend);
    const finalService = new WorkflowExecutionService(finalHost, f.workflows, f.secrets, f.config, runtimePath);
    await finalHost.load(); finalService.reconcile(); finalService.reconcile();
    assert.equal(finalBackend.sessions.length, 0, 'reconcile neither replays work nor duplicates completion');
    assert.equal(finalService.scheduler.occupied(f.id), false);
    await finalHost.shutdown();
  } finally { await other?.shutdown(); await f.close(); }
});

it('checks actual Project identity and accepts its owned Worktree, not a path prefix', async () => {
  const f = await fixture();
  try {
    execFileSync('git', ['init', '-b', 'main', f.root], { stdio: 'ignore' });
    execFileSync('git', ['-C', f.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], { stdio: 'ignore' });
    const id = await f.host.create({ scope: f.root, backend: 'fake', worktree: { from: 'main' } });
    const restricted: WorkflowDefinition = { ...definition, projectId: f.root, steps: [{ id: 'join', name: 'Join', kind: 'join' }] };
    const started = await f.service.start({ sessionId: id, definition: restricted, input: {} });
    assert.equal((await f.service.scheduler.wait(id, started.execution.id)).status, 'completed');
    mkdirSync(join(f.root, 'child'));
    const child = await f.host.create({ scope: join(f.root, 'child'), backend: 'fake' });
    await assert.rejects(f.service.start({ sessionId: child, definition: restricted, input: {} }), /another Project/);
    const alias = f.root + '-alias'; symlinkSync(f.root, alias);
    try {
      const aliased = await f.service.start({ sessionId: f.id, definition: { ...restricted, projectId: alias }, input: {} });
      assert.equal((await f.service.scheduler.wait(f.id, aliased.execution.id)).status, 'completed');
    } finally { rmSync(alias); }
  } finally { await f.close(); }
});

it('keeps auto-accept Enquiries independent, interrupts on backend errors, and rejects Ended launches', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition: { ...definition, permission: 'auto-accept' }, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    handle.ask([{ header: 'Pick', question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]);
    assert.equal(f.host.statusOf(f.id), 'idle');
    assert.equal(f.service.view(f.id, started.execution.id).enquiries.length, 1);
    assert.equal(handle.answers.length, 0);
    f.backend.latest.fail();
    await until(() => f.service.view(f.id, started.execution.id).execution.status === 'recovery-required');
    await f.service.scheduler.wait(f.id, started.execution.id);
    assert.equal(f.service.view(f.id, started.execution.id).enquiries.length, 0);
    await f.service.cancel(f.id, started.execution.id);
    await f.host.dispose(f.id);
    assert.equal((await f.request(f.base, 'POST', { workflowId: definition.id, input: {} })).status, 400);
    assert.equal((await f.request(f.base)).status, 200);
  } finally { await f.close(); }
});

it('runs real Shell and TypeScript through HTTP with a fixed runtime while Settings change', async () => {
  const f = await fixture();
  try {
    const shell: WorkflowDefinition = { ...definition, steps: [{ id: 'shell', name: 'Shell', kind: 'shell', command: 'sleep 0.1; printf ok' }] };
    f.workflows.saveDefinition(shell);
    const response = await f.request(f.base, 'POST', { workflowId: shell.id, input: {} });
    assert.equal(response.status, 200);
    const started = await response.json() as WorkflowExecutionView;
    f.workflows.saveDefinition({ ...shell, name: 'Edited', steps: [{ id: 'shell', name: 'Shell', kind: 'shell', command: 'printf changed' }] });
    await f.request('/api/config', 'PUT', { workflowRuntime: { nodePath: '/missing/node' } });
    const result = await f.service.scheduler.wait(f.id, started.execution.id);
    assert.deepEqual(result.result, { exitCode: 0, stdout: 'ok', stderr: '' });
    assert.equal((await f.request(f.base, 'POST', { workflowId: shell.id, input: {} })).status, 400);
    await f.request('/api/config', 'PUT', { workflowRuntime: { nodePath: process.execPath } });
    f.secrets.set('CODE_KEY', 'code-"quote\nline');
    const ts: WorkflowDefinition = { ...definition, steps: [{ id: 'ts', name: 'TypeScript', kind: 'typescript', code: 'return secrets.token;', secrets: { token: 'CODE_KEY' }, outputSchema: { type: 'string' } }] };
    const response2 = await f.request('/api/workflows/test', 'POST', { definition: ts, sessionId: f.id, stepId: 'ts', input: {} });
    assert.equal(response2.status, 200);
    const started2 = await response2.json() as WorkflowExecutionView;
    assert.equal((await f.service.scheduler.wait(f.id, started2.execution.id)).result, '[REDACTED]');
  } finally { await f.close(); }
});

it('redacts quote/newline secrets in private Agent activity and output; cancellation does not start successors', async () => {
  const f = await fixture();
  try {
    const canary = 'secret-"quote\nline'; f.secrets.set('KEY', canary);
    const secretDefinition = { ...definition, steps: [{ ...definition.steps[0]!, secrets: { token: 'KEY' } }] };
    f.workflows.saveDefinition(secretDefinition);
    const started = await (await f.request(f.base, 'POST', { workflowId: definition.id, input: {} })).json() as WorkflowExecutionView;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    assert.ok(handle.options.instructions.includes(JSON.stringify(canary)));
    handle.emit({ type: 'notice', level: 'info', text: JSON.stringify({ token: canary }) });
    handle.complete(canary);
    await f.service.scheduler.wait(f.id, started.execution.id); await pause();
    const view = await (await f.request(f.base + '/' + started.execution.id)).json() as WorkflowExecutionView;
    assert.equal(view.execution.result, '[REDACTED]');
    assert.ok(!JSON.stringify(view).includes('secret-'));
    const activity = readFileSync(join(f.root, 'sessions', f.id, 'workflow-activity', started.execution.id + '.json'), 'utf8');
    assert.ok(!activity.includes('secret-'));
    assert.ok(!JSON.stringify(f.host.logFor(f.id).since(0)).includes('secret-'));
    const second = await (await f.request(f.base, 'POST', { workflowId: definition.id, input: {} })).json() as WorkflowExecutionView;
    assert.equal((await f.request(f.base + '/' + second.execution.id + '/cancel', 'POST')).status, 200);
    assert.equal(f.service.scheduler.occupied(f.id), false);
  } finally { await f.close(); }
});

for (const secret of ['type', 'asked', 'raw', 'question', 'options', 'header', 'multiSelect', 'label', 'description', 'private-"quote\nline']) {
  it(`preserves private request structure and routing with secret ${secret}`, async () => {
    const f = await fixture();
    try {
      f.secrets.set('KEY', secret);
      const started = await f.service.start({ sessionId: f.id, definition: { ...definition, steps: [{ ...definition.steps[0]!, secrets: { token: 'KEY' } }] }, input: {} });
      const executionId = started.execution.id;
      await until(() => f.backend.latest.workflowSubagents.length === 1);
      const handle = f.backend.latest.workflowSubagents[0]!;
      const view = () => f.service.view(f.id, executionId);
      const questions = [{ header: secret, question: secret, multiSelect: false, options: [{ label: secret, description: secret }, { label: 'Other' }] }];
      const ids = new Set<string>();
      for (let i = 0; i < 2; i++) {
        const rawCall = `${secret}-call-${i}`, rawAsk = `${secret}-ask-${i}`;
        handle.emit({ type: 'tool_started', callId: rawCall, name: 'Bash', input: { [secret]: secret, nested: { type: secret } } });
        handle.requestPermission(`Bash ${secret}`, rawCall);
        handle.ask(questions, rawAsk);
        const permission = view().permissions[0]!, enquiry = view().enquiries[0]!;
        assert.ok(permission); assert.ok(enquiry);
        assert.notEqual(permission.callId, rawCall); assert.notEqual(enquiry.askId, rawAsk);
        ids.add(permission.callId); ids.add(enquiry.askId);
        assert.deepEqual(enquiry.questions, [{ header: '[REDACTED]', question: '[REDACTED]', multiSelect: false, options: [{ label: '[REDACTED]', description: '[REDACTED]' }, { label: 'Other' }] }]);
        const tool = view().activity.at(-3)!.event;
        assert.equal(tool.type, 'tool_started');
        if (tool.type === 'tool_started') {
          assert.equal(tool.callId, permission.callId);
          assert.ok(!JSON.stringify(tool.input).includes(secret));
        }
        await f.service.answer(f.id, executionId, { subagentId: handle.options.id, callId: permission.callId, decision: 'allow' });
        await f.service.answer(f.id, executionId, { subagentId: handle.options.id, askId: enquiry.askId, answers: [[secret]] });
        assert.deepEqual(handle.decisions.at(-1), { callId: rawCall, decision: 'allow' });
        assert.deepEqual(handle.answers.at(-1), { askId: rawAsk, answers: [[secret]] });
        assert.equal(view().permissions.length, 0); assert.equal(view().enquiries.length, 0);
        const answered = view().activity.at(-1)!.event;
        assert.equal(answered.type, 'enquiry');
        if (answered.type === 'enquiry') {
          assert.equal(answered.state, 'answered'); assert.equal(answered.askId, enquiry.askId);
          if (answered.state === 'answered') assert.deepEqual(answered.answers, [['[REDACTED]']]);
        }
        await assert.rejects(f.service.answer(f.id, executionId, { subagentId: handle.options.id, askId: enquiry.askId, answers: [['Other']] }));
      }
      assert.equal(ids.size, 4);
      handle.requestPermission('Bash', `${secret}-aborted-call`);
      handle.ask(questions, `${secret}-aborted-ask`);
      handle.emit({ type: 'permission', state: 'aborted', callId: `${secret}-aborted-call`, tool: 'Bash' });
      handle.emit({ type: 'enquiry', state: 'aborted', askId: `${secret}-aborted-ask`, questions });
      assert.equal(view().permissions.length, 0); assert.equal(view().enquiries.length, 0);
      handle.complete(secret);
      const result = await f.service.scheduler.wait(f.id, executionId);
      assert.equal(result.result, '[REDACTED]');
      assert.equal(f.workflows.getExecution(f.id, executionId).result, '[REDACTED]');
      const saved = readFileSync(join(f.root, 'sessions', f.id, 'workflow-activity', executionId + '.json'), 'utf8');
      assert.ok(!saved.includes(`${secret}-call-`)); assert.ok(!saved.includes(`${secret}-ask-`));
      const persisted = JSON.parse(saved);
      assert.deepEqual(persisted.activity, view().activity);
      assert.equal(persisted.permissions.length, 0); assert.equal(persisted.enquiries.length, 0);
    } finally { await f.close(); }
  });
}

it('persists complete redacted paginated activity across attempts and restart, including large events', async () => {
  const f = await fixture();
  try {
    f.secrets.set('TOKEN', 'private-token-value');
    const started = await f.service.start({ sessionId: f.id, definition: { ...definition, steps: [{ ...definition.steps[0]!, secrets: { token: 'TOKEN' } }] }, input: {} });
    const eid = started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const first = f.backend.latest.workflowSubagents[0]!;
    for (let i = 0; i < 215; i++) first.emit({ type: 'notice', level: 'info', text: `${i}: private-token-value ${'x'.repeat(i === 0 ? 250_000 : 1000)}` });
    first.fail();
    await f.service.scheduler.wait(f.id, eid);
    await f.service.recover(f.id, eid, { kind: 'retry', stepId: 'agent' });
    await until(() => f.backend.latest.workflowSubagents.length === 2);
    const second = f.backend.latest.workflowSubagents[1]!;
    second.emit({ type: 'notice', level: 'info', text: 'second attempt' });
    second.complete('y'.repeat(250_000));
    assert.equal((await f.service.scheduler.wait(f.id, eid)).result, 'y'.repeat(250_000));
    const restarted = new WorkflowExecutionService(f.host, f.workflows, f.secrets, f.config, runtimePath);
    let cursor = 0;
    const events = [];
    while (true) {
      const page = await restarted.activity(f.id, eid, { after: cursor, limit: 37, attempt: 1 });
      assert.equal(page.historyComplete, true);
      events.push(...page.activity);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    const serialized = JSON.stringify(events);
    assert.ok(events.length >= 215);
    assert.ok(serialized.includes('x'.repeat(250_000)));
    assert.ok(!serialized.includes('private-token-value'));
    assert.ok(serialized.includes('[REDACTED]'));
    const last = await restarted.activity(f.id, eid, { attempt: 2 });
    assert.ok(JSON.stringify(last).includes('second attempt'));
    assert.ok(last.activity.every(event => event.attempt === 2));
    const response = await f.request(`${f.base}/${eid}/activity?attempt=1&limit=10`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { activity: unknown[] }).activity.length, 10);
    await assert.rejects(restarted.activity('wrong-session', eid));
  } finally { await f.close(); }
});

it('recovers activity sequences when the durable log is ahead of the preview', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    const eid = started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const path = join(f.root, 'sessions', f.id, 'workflow-activity', `${eid}.json`);
    const stalePreview = readFileSync(path, 'utf8');
    f.backend.latest.workflowSubagents[0]!.emit({ type: 'notice', level: 'info', text: 'durable before crash' });
    await f.host.shutdown();
    writeFileSync(path, stalePreview);
    const backend = new FakeBackend();
    const host = new SessionHost({ store: f.store, retention: 0 });
    host.registerBackend(backend);
    const restarted = new WorkflowExecutionService(host, f.workflows, f.secrets, f.config, runtimePath);
    try {
      await host.load();
      restarted.reconcile();
      await restarted.recover(f.id, eid, { kind: 'retry', stepId: 'agent' });
      await until(() => backend.latest.workflowSubagents.length === 1);
      const handle = backend.latest.workflowSubagents[0]!;
      handle.emit({ type: 'notice', level: 'info', text: 'after recovery' });
      handle.emit({ type: 'notice', level: 'info', text: 'another event' });
      handle.complete('done');
      await restarted.scheduler.wait(f.id, eid);
      const events = [];
      let after = 0;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await restarted.activity(f.id, eid, { after, limit: 1 });
        assert.equal(page.historyComplete, true);
        events.push(...page.activity);
        if (page.next === undefined) break;
        assert.ok(page.next > after);
        after = page.next;
      }
      assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
      assert.deepEqual(events.map(event => event.attempt), [1, 2, 2]);
      assert.deepEqual(events.map(event => event.event), [
        { type: 'notice', level: 'info', text: 'durable before crash' },
        { type: 'notice', level: 'info', text: 'after recovery' },
        { type: 'notice', level: 'info', text: 'another event' },
      ]);
    } finally { await host.shutdown(); }
  } finally { await f.close(); }
});

it('provides fresh compact parent context and queues/deduplicates recovery notifications while busy', async () => {
  const f = await fixture();
  try {
    await f.host.send(f.id, 'Keep working', 'now');
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    const eid = started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.backend.latest.workflowSubagents[0]!.emit({ type: 'notice', level: 'info', text: 'transcript-not-context' });
    f.backend.latest.workflowSubagents[0]!.fail();
    await f.service.scheduler.wait(f.id, eid);
    await pause();
    assert.equal(f.backend.latest.prompts.length, 1);
    f.backend.latest.completeTurn('complete');
    await until(() => f.backend.latest.prompts.length === 2);
    const notification = f.backend.latest.prompts[1]!;
    assert.ok(notification.includes(eid));
    assert.ok(notification.includes('recovery-required'));
    assert.ok(!notification.includes('transcript-not-context'));
    const summary = await f.service.parent(f.id).inspect({}) as { revision: string; executionId: string };
    assert.equal(summary.executionId, eid);
    f.host.workflowWake(f.id, eid, summary.revision);
    f.backend.latest.completeTurn('complete');
    await pause();
    assert.equal(f.backend.latest.prompts.length, 2);
    await f.host.send(f.id, 'What happened?', 'now');
    assert.ok(f.backend.latest.prompts.at(-1)!.includes(eid));
    assert.ok(f.service.context(f.id).includes('recovery-required'));
    await assert.rejects(f.service.parent(f.id).recover({ executionId: eid, revision: summary.revision, action: { kind: 'retry', stepId: 'agent' } }), /User direction required/);
    await assert.rejects(f.service.parent(f.id).recover({ executionId: eid, revision: 'stale', action: { kind: 'retry', stepId: 'agent' } }), /no longer available/);
    await f.service.cancel(f.id, eid);
    assert.ok(f.service.context(f.id).includes('cancelled'));
  } finally { await f.close(); }
});

it('wakes an idle parent and requires an actual one-shot confirmation for replacement output', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    const eid = started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.backend.latest.workflowSubagents[0]!.fail();
    await f.service.scheduler.wait(f.id, eid);
    await until(() => f.backend.latest.prompts.length === 1);
    const summary = await f.service.parent(f.id).inspect({}) as { revision: string };
    const input = { executionId: eid, revision: summary.revision, action: { kind: 'supply' as const, stepId: 'agent', output: 'fixed' }, confirm: true };
    const pending = f.service.parent(f.id).recover(input);
    const getEnquiry = () => reduceAll(f.host.logFor(f.id).since(0)).asking;
    await until(() => !!getEnquiry());
    assert.equal(f.service.view(f.id, eid).execution.status, 'recovery-required');
    await f.host.answerEnquiry(f.id, getEnquiry()!.askId, [['Recover']]);
    await pending;
    assert.equal((await f.service.scheduler.wait(f.id, eid)).result, 'fixed');
    await assert.rejects(f.service.parent(f.id).recover(input), /no longer available/);
  } finally { await f.close(); }
});

it('allows only one safe automatic recovery before progress, including after restart', async () => {
  const f = await fixture();
  try {
    const graph: WorkflowDefinition = { ...definition, inputSchema: { type: 'object', fields: { ready: { schema: { type: 'boolean' }, required: true } } }, steps: [{ id: 'check', name: 'Check flag', kind: 'branch', condition: { operator: 'truthy', path: ['ready'] } }], edges: [] };
    const started = await f.service.start({ sessionId: f.id, definition: graph, input: { ready: true } });
    const eid = started.execution.id;
    // A retained input-mapping failure: retry must keep the failed attempt's input,
    // not silently substitute a new input or mint another automatic allowance.
    const failed = await f.service.scheduler.wait(f.id, eid);
    failed.status = 'recovery-required';
    delete failed.result;
    failed.steps.check = { status: 'failed', outcome: 'failure', attempts: [{ number: 1, action: 'execute', startedAt: 1, finishedAt: 2, input: null, error: { kind: 'failure', message: 'Input mapping failed' } }] };
    f.workflows.saveExecution(failed);
    const service = new WorkflowExecutionService(f.host, f.workflows, f.secrets, f.config, runtimePath);
    const parent = service.parent(f.id);
    const before = await parent.inspect({}) as { revision: string; automaticRecoveryAvailable: boolean };
    assert.equal(before.automaticRecoveryAvailable, true);
    await parent.recover({ executionId: eid, revision: before.revision, action: { kind: 'retry', stepId: 'check' } });
    assert.equal((await service.scheduler.wait(f.id, eid)).status, 'recovery-required');
    const restarted = new WorkflowExecutionService(f.host, f.workflows, f.secrets, f.config, runtimePath);
    const after = await restarted.parent(f.id).inspect({}) as typeof before;
    assert.notEqual(after.revision, before.revision);
    assert.equal(after.automaticRecoveryAvailable, false);
    await assert.rejects(restarted.parent(f.id).recover({ executionId: eid, revision: after.revision, action: { kind: 'retry', stepId: 'check' } }), /User direction required/);
    assert.equal(restarted.view(f.id, eid).execution.steps.check!.attempts.length, 2);
  } finally { await f.close(); }
});

it('queues exact Workflow questions behind a running parent, then relays and forwards one response', async () => {
  const f = await fixture();
  try {
    await f.host.send(f.id, 'Parent request already in progress', 'now');
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    const questions = [
      { header: 'Targets', question: 'Which targets?', multiSelect: true, options: [{ label: 'Web', description: 'Browser client' }, { label: 'CLI', description: 'Terminal client' }] },
      { header: 'Notes', question: 'Anything else?', multiSelect: false, options: [{ label: 'None' }, { label: 'Explain' }] },
    ];
    handle.ask(questions, 'private-relay-ask');
    await pause();
    assert.equal(f.backend.latest.prompts.length, 1, 'the Workflow request does not interrupt the running parent');
    f.backend.latest.completeTurn();
    await until(() => f.backend.latest.prompts.some(prompt => prompt.includes('workflow_relay_enquiry')));
    const prompt = f.backend.latest.prompts.find(text => text.includes('workflow_relay_enquiry'))!;
    assert.ok(prompt.includes('Workflow “Sample” · Step “Agent” · Attempt 1'));
    assert.ok(prompt.includes('Which targets?'));
    assert.ok(prompt.includes('Anything else?'));
    const requestId = /requestId "([0-9a-f-]+)"/.exec(prompt)?.[1];
    assert.ok(requestId);
    const relay = f.backend.latest.workflow!.relayEnquiry({ requestId });
    const asking = () => reduceAll(f.host.logFor(f.id).since(0)).asking;
    await until(() => asking()?.context?.includes('Workflow “Sample”') === true);
    assert.deepEqual(asking()!.questions, questions);
    const answers = [['Web', 'CLI'], ['Free text from the human']];
    await f.host.answerEnquiry(f.id, asking()!.askId, answers);
    await relay;
    assert.deepEqual(handle.answers, [{ askId: 'private-relay-ask', answers }]);
    await assert.rejects(f.backend.latest.workflow!.relayEnquiry({ requestId }), /no longer available/);
    f.backend.latest.completeTurn();
    handle.complete('done');
    await f.service.scheduler.wait(f.id, started.execution.id);
  } finally { await f.close(); }
});

it('retries an ignored relay once without buying a third parent turn', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.backend.latest.workflowSubagents[0]!.ask([
      { header: 'Target', question: 'Which target?', multiSelect: false, options: [{ label: 'Web' }] },
    ], 'ignored-ask');
    await until(() => f.backend.latest.prompts.length === 1);

    f.backend.latest.completeTurn();
    await until(() => f.backend.latest.prompts.length === 2);
    f.backend.latest.completeTurn();
    await pause();

    assert.equal(f.backend.latest.prompts.length, 2);
    await f.service.cancel(f.id, started.execution.id);
  } finally { await f.close(); }
});

it('relays Workflow permissions with exact scope and rejects Always for direct calls in the shared control', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    handle.emit({ type: 'tool_started', callId: 'private-call', name: 'Bash', input: { command: 'printf ok' } });
    handle.requestPermission('Bash', 'private-call');
    await until(() => f.backend.latest.prompts.some(prompt => prompt.includes('workflow_relay_permission')));
    const prompt = f.backend.latest.prompts.find(text => text.includes('workflow_relay_permission'))!;
    assert.ok(prompt.includes('always allow'));
    assert.ok(prompt.includes('printf ok'));
    const requestId = /requestId "([0-9a-f-]+)"/.exec(prompt)?.[1];
    assert.ok(requestId);
    const relay = f.backend.latest.workflow!.relayPermission({ requestId });
    const authorising = () => reduceAll(f.host.logFor(f.id).since(0)).authorising;
    await until(() => authorising()?.tool === 'Bash');
    assert.equal(authorising()!.allowAlways, true);
    assert.match(authorising()!.authorizationScope ?? '', /always allow Bash on this machine/);
    const relayTool = reduceAll(f.host.logFor(f.id).since(0)).entries.find(entry => entry.kind === 'tool' && entry.id === authorising()!.callId);
    assert.deepEqual(relayTool?.kind === 'tool' ? relayTool.input : undefined, { command: 'printf ok' });
    await f.host.answerPermission(f.id, authorising()!.callId, 'allow');
    await relay;
    assert.deepEqual(handle.decisions, [{ callId: 'private-call', decision: 'allow' }]);
    handle.complete('done');
    await f.service.scheduler.wait(f.id, started.execution.id);
  } finally { await f.close(); }
});

it('keeps compaction progress and successful markers inside the Workflow attempt transcript', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    handle.emit({ type: 'compacting', active: true });
    let page = await f.service.activity(f.id, started.execution.id, { stepId: 'agent', attempt: 1 });
    assert.equal(reduceAll(page.activity.flatMap(item => item.event.type === 'spend' ? [] : [{
      sessionId: f.id, seq: item.sequence, at: new Date(item.at).toISOString(), event: item.event,
    }])).compacting, true);
    assert.equal(f.host.logFor(f.id).since(0).some(({ event }) => event.type === 'compacting' || event.type === 'compacted'), false);

    handle.emit({ type: 'compacting', active: false });
    handle.emit({ type: 'compacted', trigger: 'auto', before: 84_000 });
    handle.complete('done');
    await f.service.scheduler.wait(f.id, started.execution.id);
    page = await f.service.activity(f.id, started.execution.id, { stepId: 'agent', attempt: 1 });
    const reduced = reduceAll(page.activity.flatMap(item => item.event.type === 'spend' ? [] : [{
      sessionId: f.id, seq: item.sequence, at: new Date(item.at).toISOString(), event: item.event,
    }]));
    assert.equal(reduced.compacting, undefined);
    assert.ok(reduced.entries.some(entry => entry.kind === 'marker' && entry.marker === 'compacted' &&
      entry.text === 'Compacted automatically, from 84k tokens'));
    assert.equal(f.host.logFor(f.id).since(0).some(({ event }) => event.type === 'compacting' || event.type === 'compacted'), false);
  } finally { await f.close(); }
});

it('opens activity from the retained tail and pages backward without changing forward pagination', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    const handle = f.backend.latest.workflowSubagents[0]!;
    for (let i = 1; i <= 125; i++) handle.emit({ type: 'notice', level: 'info', text: `event ${i}` });
    const latest = await f.service.activity(f.id, started.execution.id, { latest: true, limit: 20, stepId: 'agent', attempt: 1 });
    assert.deepEqual(latest.activity.map(item => item.sequence), Array.from({ length: 20 }, (_, index) => 106 + index));
    assert.equal(latest.previous, 106);
    const older = await f.service.activity(f.id, started.execution.id, { before: latest.previous, limit: 20, stepId: 'agent', attempt: 1 });
    assert.deepEqual(older.activity.map(item => item.sequence), Array.from({ length: 20 }, (_, index) => 86 + index));
    assert.equal(older.previous, 86);
    const forward = await f.service.activity(f.id, started.execution.id, { after: 105, limit: 5, stepId: 'agent', attempt: 1 });
    assert.deepEqual(forward.activity.map(item => item.sequence), [106, 107, 108, 109, 110]);
    assert.equal(forward.next, 110);
    handle.complete('done');
    await f.service.scheduler.wait(f.id, started.execution.id);
  } finally { await f.close(); }
});

it('reports unavailable legacy history honestly while keeping retained events inspectable', async () => {
  const f = await fixture();
  try {
    const started = await f.service.start({ sessionId: f.id, definition, input: {} });
    const eid = started.execution.id;
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    f.backend.latest.workflowSubagents[0]!.emit({ type: 'notice', level: 'info', text: 'retained legacy activity' });
    f.backend.latest.workflowSubagents[0]!.complete('done');
    await f.service.scheduler.wait(f.id, eid);
    const path = join(f.root, 'sessions', f.id, 'workflow-activity', `${eid}.json`);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.historyComplete;
    for (const item of saved.activity) delete item.attempt;
    writeFileSync(path, JSON.stringify(saved));
    rmSync(path + 'l');
    const restarted = new WorkflowExecutionService(f.host, f.workflows, f.secrets, f.config, runtimePath);
    const page = await restarted.activity(f.id, eid);
    assert.equal(page.historyComplete, false);
    assert.ok(JSON.stringify(page.activity).includes('retained legacy activity'));
  } finally { await f.close(); }
});
