import assert from 'node:assert/strict';
import { it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, renameSync, realpathSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BackendCreateOptions, BackendSession } from '../src/backend/types.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import { WorkflowBuilderService, type WorkflowBuilderServiceOptions } from '../src/daemon/workflow-builder.ts';
import { serve } from '../src/daemon/server.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { WorkflowBuilderFiles } from '../src/daemon/workflow-builder-files.ts';

const draft = (): WorkflowDefinition => ({ version: 1, id: 'draft', name: 'Draft', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] });
const valid = (): WorkflowDefinition => ({ ...draft(), steps: [{ id: 'one', name: 'One', kind: 'join' }] });
async function wait(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(check()); }
function fixture(overrides: Partial<WorkflowBuilderServiceOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-builder-test-')));
  const state = join(root, 'state'); const machine = join(root, 'machine'); const project = join(root, 'project');
  for (const path of [state, machine, project]) mkdirSync(path);
  const sessions: Array<{ options: BackendCreateOptions; session: BackendSession; aborted: number; disposed: number; prompts: string[] }> = [];
  const starts: BackendCreateOptions[] = [];
  let projectRoot: string | undefined = machine;
  let rejectPrompt = false;
  let createWait: Promise<void> | undefined;
  let disposeWait: Promise<void> | undefined;
  const host = {
    models: async () => [{ backend: 'fake', models: [{ id: 'model', effortLevels: ['low', 'high'] as Array<'low' | 'high'> }, { id: 'plain' }] }],
    createWorkflowBuilderSession: async (_backend: string, options: BackendCreateOptions) => {
      starts.push(options);
      if (createWait) await createWait;
      const entry = { options, aborted: 0, disposed: 0, prompts: [] as string[], session: undefined as unknown as BackendSession };
      entry.session = {
        capabilities: { models: [], providers: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
        resumeToken: () => undefined, setModel: async () => {}, setEffort: async () => {},
        prompt: async text => { entry.prompts.push(text); if (rejectPrompt) throw new Error('private-credential-raw-error'); },
        abort: async () => { entry.aborted++; }, dispose: async () => { entry.disposed++; if (disposeWait) await disposeWait; },
      };
      sessions.push(entry); return entry.session;
    },
  };
  const config = { projectRoot: () => projectRoot, projectInclude: () => [project], defaultModel: () => 'model', defaultEffort: () => 'low' as const };
  const service = new WorkflowBuilderService({ host, config, scope: project, stateRoot: state, ...overrides });
  return { root, state, machine, project, service, sessions, starts, host, config,
    noProjectRoot: () => { projectRoot = undefined; }, rejectPrompt: () => { rejectPrompt = true; }, delayCreate: (wait: Promise<void>) => { createWait = wait; },
    delayDispose: (wait: Promise<void>) => { disposeWait = wait; },
    cleanup: async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); },
  };
}

it('pins opted-in Project, machine root and fallback Scope; rejects unlisted Project', async () => {
  const f = fixture();
  try {
    const machine = await f.service.create({ definition: draft() });
    assert.equal(machine.scope, f.machine);
    const project = await f.service.create({ definition: { ...draft(), projectId: f.project } });
    assert.equal(project.scope, f.project);
    await assert.rejects(f.service.create({ definition: { ...draft(), projectId: f.machine } }), /not opted in/);
    f.noProjectRoot();
    assert.equal((await f.service.create({ definition: draft() })).scope, f.project);
    const { options } = f.sessions[0]!;
    assert.notEqual(options.scope, machine.scope);
    assert.equal(statSync(options.scope).mode & 0o777, 0o700);
    assert.equal(statSync(join(dirname(options.scope), 'workflow.json')).mode & 0o777, 0o600);
    assert.equal(options.mcp, undefined); assert.equal(options.workflow, undefined); assert.equal(options.standingAuthorisations, undefined);
    assert.ok(options.workflowBuilder!.instructions.includes('repeatMapping'));
    assert.ok(options.workflowBuilder!.instructions.includes('"plain"'));
    assert.ok(options.workflowBuilder!.instructions.includes('maxTries'));
    await f.service.close(machine.id);
    assert.ok(!existsSync(options.scope));
  } finally { await f.cleanup(); }
});

it('rejects sibling traversal, final/ancestor symlinks, special files, protected state and credential references', async () => {
  const f = fixture();
  let files: WorkflowBuilderFiles | undefined;
  try {
    writeFileSync(join(f.root, 'outside'), 'private');
    writeFileSync(join(f.machine, 'ok'), 'reference');
    writeFileSync(join(f.machine, '.env'), 'credential');
    writeFileSync(join(f.machine, 'certificate.pem'), 'credential');
    writeFileSync(join(f.state, 'token'), 'state-secret');
    mkdirSync(join(f.machine, 'dir')); writeFileSync(join(f.machine, 'dir/ok'), 'nested');
    symlinkSync(join(f.root, 'outside'), join(f.machine, 'link'));
    symlinkSync(join(f.machine, 'dir'), join(f.machine, 'linked-dir'));
    symlinkSync(f.state, join(f.machine, 'state-link'));
    linkSync(join(f.state, 'token'), join(f.machine, 'aliased-state'));
    execFileSync('mkfifo', [join(f.machine, 'pipe')]);
    files = await WorkflowBuilderFiles.create(f.root, f.state);
    assert.equal(await files.read('machine/ok'), 'reference');
    for (const path of ['../outside', f.root + '-sibling/secret', 'machine/link', 'machine/linked-dir/ok', 'machine/state-link/token', 'machine/pipe', 'state/token', 'machine/.env', 'machine/certificate.pem', 'machine/aliased-state']) {
      await assert.rejects(files.read(path), /reference unavailable/);
    }
    for (const path of ['../', 'state', 'machine/linked-dir']) await assert.rejects(files.list(path));
    assert.ok(!(await files.list('.')).includes('state'));
    assert.ok(!(await files.list('machine')).includes('.env'));
    await assert.rejects(WorkflowBuilderFiles.create(join(f.machine, 'linked-dir'), f.state));
    writeFileSync(join(f.machine, 'huge'), 'x'.repeat(128_001));
    await assert.rejects(files.read('machine/huge'));
    for (let i = 0; i < 220; i++) writeFileSync(join(f.machine, 'dir', String(i)), '');
    const listing = await files.list('machine/dir');
    assert.ok(listing.includes('truncated')); assert.ok(listing.split('\n').length <= 201);
    // A root redirected after creation is not silently re-resolved or followed.
    await files.close(); files = await WorkflowBuilderFiles.create(f.machine, f.state);
    renameSync(f.machine, f.machine + '-old'); mkdirSync(f.machine); writeFileSync(join(f.machine, 'ok'), 'redirected');
    await assert.rejects(files.read('ok'));
    await files.close(); files = await WorkflowBuilderFiles.create('/', f.state);
    await assert.rejects(files.read('/proc/self/environ'));
    await assert.rejects(files.list('/dev'));
  } finally { await files?.close(); await f.cleanup(); }
});

it('validates whole own workflow.json, immutable identity/backend/Project, model/effort and injected credentials without losing the draft', async () => {
  const f = fixture({ validateDefinition: value => { if (value.name === 'credential') throw new Error('raw-token'); } });
  try {
    const view = await f.service.create({ definition: draft() });
    const tool = f.sessions[0]!.options.workflowBuilder!;
    await assert.rejects(tool.write(JSON.stringify(valid())), /not active/);
    f.service.message(view.id, 'Build it');
    assert.equal(JSON.parse(await tool.read('workflow.json')).steps.length, 0);
    const writing = tool.write(JSON.stringify(valid()));
    await assert.rejects(tool.write(JSON.stringify(valid())), /in progress/);
    await writing;
    const accepted = f.service.view(view.id).definition;
    assert.deepEqual(accepted, valid());
    const invalids = [
      draft(), { ...valid(), id: 'other' }, { ...valid(), projectId: f.project }, { ...valid(), backend: 'other' },
      { ...valid(), name: 'credential' }, { ...valid(), edges: [{ id: 'e', from: 'missing', to: 'one', outcome: 'success' }] },
      { ...valid(), steps: [{ id: 'a', name: 'A', kind: 'agent', instructions: '', model: 'invented', effort: 'low', outputSchema: { type: 'string' } }] },
      { ...valid(), steps: [{ id: 'a', name: 'A', kind: 'agent', instructions: '', model: 'plain', effort: 'high', outputSchema: { type: 'string' } }] },
    ];
    for (const value of invalids) {
      await assert.rejects(tool.write(JSON.stringify(value)), /previous draft preserved/);
      assert.deepEqual(f.service.view(view.id).definition, accepted);
      assert.deepEqual(JSON.parse(readFileSync(join(dirname(f.sessions[0]!.options.scope), 'workflow.json'), 'utf8')), accepted);
    }
    await assert.rejects(tool.write('x'.repeat(256_001)));
    await assert.rejects(tool.write('{raw-token'));
    assert.ok(!existsSync(join(f.state, 'workflows')));
    assert.throws(() => f.service.message(view.id, 'concurrent'), /busy/);
    await assert.rejects(f.service.create({ definition: valid(), modelId: 'missing' }), /model is unavailable/);
    await assert.rejects(f.service.create({ definition: valid(), effort: 'max' }), /Effort is unsupported/);
    await assert.rejects(f.service.create({ definition: valid(), effort: 'invented' as never }), /Effort is unsupported/);
    await f.service.create({ definition: valid(), modelId: 'plain' });
    assert.equal(f.sessions.at(-1)!.options.effort, 'off'); // Ignore a saved default for no-control models.
  } finally { await f.cleanup(); }
});

it('returns an immediate running turn, snapshots assistant messages/Spend, rejects overlap and fences late events/tools after cancellation', async () => {
  const f = fixture();
  try {
    const view = await f.service.create({ definition: draft() });
    const first = f.sessions[0]!;
    assert.equal(f.service.message(view.id, 'Hello').status, 'running');
    assert.ok(f.service.hasActiveWork());
    first.options.emit({ type: 'message', id: 'answer', text: 'partial', final: false });
    assert.equal(f.service.view(view.id).messages[1]!.final, false);
    first.options.emit({ type: 'message', id: 'answer', text: 'complete', final: true });
    first.options.emit({ type: 'context_usage', used: 1, window: 100, spend: { tokens: 3, cached: 0, costUSD: 0.01, models: [] } });
    first.options.emit({ type: 'turn_ended', turnId: 't', reason: 'complete' });
    first.options.emit({ type: 'context_usage', used: 2, window: 100, spend: { tokens: 5, cached: 0, costUSD: 0.02, models: [] } });
    assert.equal(f.service.view(view.id).messages.length, 2);
    assert.equal(f.service.view(view.id).messages[1]!.text, 'complete');
    assert.equal(f.service.view(view.id).messages[1]!.final, true);
    assert.deepEqual(f.service.view(view.id).contextUsage, { used: 2, window: 100 });
    assert.equal(f.service.view(view.id).spend!.tokens, 5);
    assert.ok(!f.service.hasActiveWork());
    f.service.message(view.id, 'Again');
    const abortion = f.service.abort(view.id);
    assert.throws(() => f.service.message(view.id, 'While aborting'), /busy/);
    const stopped = await abortion;
    assert.equal(stopped.status, 'idle'); assert.equal(first.disposed, 1); assert.equal(first.aborted, 1);
    first.options.emit({ type: 'message', id: 'late', text: 'must not appear', final: true });
    await assert.rejects(first.options.workflowBuilder!.write(JSON.stringify(valid())));
    assert.ok(!f.service.view(view.id).messages.some(message => message.id === 'late'));
    f.service.message(view.id, 'Continue');
    await wait(() => f.sessions.length === 2);
    const second = f.sessions[1]!;
    assert.equal(second.options.priorSpend!.tokens, 5);
    await wait(() => second.prompts.length === 1);
    assert.match(second.prompts[0]!, /Hello/);
    await f.service.close(view.id);
    assert.equal(second.disposed, 1); assert.throws(() => f.service.view(view.id), /not found/);
    second.options.emit({ type: 'message', id: 'late', text: 'gone', final: true });
    await f.service.close(view.id); // idempotent
  } finally { await f.cleanup(); }
});

it('bounds message storage, turn failures, startup timeout, total builders and late startup disposal', async () => {
  const f = fixture({ limits: { maxBuilders: 1, startupMs: 60, turnMs: 25, disposeMs: 20 } });
  try {
    const view = await f.service.create({ definition: draft() });
    await assert.rejects(f.service.create({ definition: draft() }), /Too many/);
    assert.throws(() => f.service.message(view.id, 'x'.repeat(32_001)));
    const first = f.sessions[0]!;
    f.service.message(view.id, 'hi');
    for (let i = 0; i < 120; i++) first.options.emit({ type: 'message', id: String(i), text: 'x'.repeat(40_000), final: true });
    const messages = f.service.view(view.id).messages;
    assert.ok(messages.length <= 100); assert.ok(messages.reduce((size, message) => size + Buffer.byteLength(message.text), 0) <= 256_000);
    await wait(() => f.service.view(view.id).status === 'error');
    assert.equal(f.service.view(view.id).error, 'Workflow builder turn failed');
    await f.service.close(view.id);
    let release!: () => void;
    f.delayCreate(new Promise<void>(resolve => { release = resolve; }));
    await assert.rejects(f.service.create({ definition: draft() }), /could not start/);
    assert.ok(f.service.hasActiveWork());
    assert.equal(f.starts.at(-1)!.signal!.aborted, true);
    assert.ok(existsSync(f.starts.at(-1)!.scope));
    await assert.rejects(f.service.create({ definition: draft() }), /Too many/);
    release();
    await wait(() => f.sessions.length === 2 && f.sessions[1]!.disposed === 1 && !f.service.hasActiveWork());
    assert.ok(!f.service.hasActiveWork());
  } finally { await f.cleanup(); }
});

it('expires idle builders, shuts down active editors, and sanitises background prompt failures', async () => {
  const f = fixture({ limits: { idleMs: 25, lifetimeMs: 120, disposeMs: 20 } });
  try {
    const view = await f.service.create({ definition: draft() });
    await wait(() => f.sessions[0]!.disposed === 1);
    assert.throws(() => f.service.view(view.id), /not found/);
    const active = await f.service.create({ definition: draft() });
    f.rejectPrompt(); f.service.message(active.id, 'fail');
    await wait(() => f.service.view(active.id).status === 'error');
    assert.ok(!JSON.stringify(f.service.view(active.id)).includes('private-credential'));
    await f.service.shutdown();
    assert.ok(!f.service.hasActiveWork());
    await assert.rejects(f.service.create({ definition: draft() }), /unavailable/);
  } finally { await f.cleanup(); }
});

it('expires running builders at their absolute lifetime and shutdown waits for concurrent disposal', async () => {
  const f = fixture({ limits: { lifetimeMs: 200, idleMs: 5_000, disposeMs: 100 } });
  try {
    const expiring = await f.service.create({ definition: draft() });
    f.service.message(expiring.id, 'Running forever');
    await wait(() => f.sessions[0]!.disposed === 1);
    assert.throws(() => f.service.view(expiring.id), /not found/);
    const active = await f.service.create({ definition: draft() });
    f.service.message(active.id, 'Active');
    let release!: () => void;
    f.sessions[1]!.session.abort = () => new Promise<void>(resolve => { release = resolve; });
    const closing = f.service.close(active.id);
    assert.equal(f.service.close(active.id), closing);
    let stopped = false;
    const shutdown = f.service.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!stopped); assert.ok(f.service.hasActiveWork());
    release(); await closing; await shutdown;
    assert.equal(f.sessions[1]!.disposed, 1);
    assert.ok(!f.service.hasActiveWork());
  } finally { await f.cleanup(); }
});

it('accepts bounded incomplete authoring drafts but requires valid graphs on writes', async () => {
  const f = fixture();
  try {
    const incomplete: WorkflowDefinition = { ...draft(), name: '', steps: [{
      id: 'agent', name: '', kind: 'agent', instructions: '', model: '', effort: 'off',
      mapping: { kind: 'reference', reference: { source: 'step', stepId: 'missing', path: [] } },
      outputSchema: { type: 'string' },
    }], edges: [{ id: 'broken', from: 'missing', to: 'agent', outcome: 'success' }] };
    const view = await f.service.create({ definition: incomplete });
    assert.deepEqual(view.definition, incomplete);
    f.service.message(view.id, 'Repair the graph');
    const tools = f.sessions[0]!.options.workflowBuilder!;
    await assert.rejects(tools.write(JSON.stringify(incomplete)), /previous draft preserved/);
    await tools.write(JSON.stringify(valid()));
    assert.deepEqual(f.service.view(view.id).definition, valid());
    await assert.rejects(f.service.create({ definition: { ...draft(), unexpected: true } as WorkflowDefinition }));
  } finally { await f.cleanup(); }
});

it('keeps startup state until late disposal and shutdown waits for startup cancellation', async () => {
  const f = fixture({ limits: { startupMs: 1000, disposeMs: 20 } });
  let release!: () => void;
  let releaseDispose!: () => void;
  try {
    f.delayCreate(new Promise<void>(resolve => { release = resolve; }));
    f.delayDispose(new Promise<void>(resolve => { releaseDispose = resolve; }));
    const creating = f.service.create({ definition: draft() }).catch(error => error);
    await wait(() => f.starts.length === 1);
    const scope = f.starts[0]!.scope;
    let stopped = false;
    const shutdown = f.service.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stopped, false);
    assert.equal(f.starts[0]!.signal!.aborted, true);
    assert.ok(existsSync(scope));
    assert.ok(f.service.hasActiveWork());
    release();
    await wait(() => f.sessions[0]?.disposed === 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(stopped, false);
    assert.ok(existsSync(scope));
    assert.ok(f.service.hasActiveWork());
    releaseDispose();
    await shutdown;
    assert.ok(await creating instanceof Error);
    assert.equal(f.sessions[0]!.disposed, 1);
    assert.ok(!existsSync(scope));
    assert.ok(!f.service.hasActiveWork());
  } finally { release?.(); releaseDispose?.(); await f.cleanup(); }
});

it('records retiring final Spend while rejecting cancelled tools/messages and later meters', async () => {
  const f = fixture();
  try {
    const view = await f.service.create({ definition: draft() });
    const first = f.sessions[0]!;
    f.service.message(view.id, 'Build');
    first.options.emit({ type: 'context_usage', used: 1, window: 100, spend: { tokens: 10, cached: 0, costUSD: 0.1, models: [] } });
    first.session.abort = async () => {
      first.options.emit({ type: 'context_usage', used: 50, window: 200, spend: { tokens: 20, cached: 0, costUSD: 0.2, models: [] } });
      first.options.emit({ type: 'message', id: 'cancelled', text: 'Do not render', final: true });
      await assert.rejects(first.options.workflowBuilder!.read('workflow.json'));
    };
    await f.service.abort(view.id);
    assert.equal(f.service.view(view.id).spend!.costUSD, 0.2);
    assert.deepEqual(f.service.view(view.id).contextUsage, { used: 1, window: 100 });
    assert.ok(!f.service.view(view.id).messages.some(message => message.id === 'cancelled'));
    first.options.emit({ type: 'context_usage', used: 1, window: 100, spend: { tokens: 99, cached: 0, costUSD: 0.99, models: [] } });
    assert.equal(f.service.view(view.id).spend!.costUSD, 0.2);
    f.service.message(view.id, 'Continue');
    await wait(() => f.sessions.length === 2);
    assert.equal(f.sessions[1]!.options.priorSpend!.costUSD, 0.2);
  } finally { await f.cleanup(); }
});

it('owns an interrupted host draft write even after the Backend Session has stopped', async () => {
  const f = fixture();
  try {
    const view = await f.service.create({ definition: draft() });
    const session = f.sessions[0]!;
    f.service.message(view.id, 'Build');
    const writing = assert.rejects(session.options.workflowBuilder!.write(JSON.stringify(valid())), /previous draft preserved/);
    const stopped = await f.service.abort(view.id);
    assert.equal(stopped.stopping, true);
    assert.ok(f.service.hasActiveWork());
    assert.ok(existsSync(session.options.scope));
    assert.throws(() => f.service.message(view.id, 'Too soon'), /busy/);
    await Promise.all([writing, f.service.close(view.id)]);
    assert.ok(!existsSync(session.options.scope));
    assert.ok(!f.service.hasActiveWork());
  } finally { await f.cleanup(); }
});

it('bounds the abort response without abandoning slow disposal, private state or final meters', async () => {
  const f = fixture({ limits: { disposeMs: 10, maxBuilders: 1 } });
  let release = () => {};
  let releaseClose = () => {};
  try {
    const view = await f.service.create({ definition: draft() });
    const first = f.sessions[0]!;
    const original = first.session.dispose;
    first.session.dispose = () => new Promise<void>(resolve => {
      release = () => {
        release = () => {};
        first.options.emit({ type: 'context_usage', used: 1, window: 100, spend: { tokens: 40, cached: 0, costUSD: 0.4, models: [] } });
        void original().then(resolve);
      };
    });
    f.service.message(view.id, 'Build');
    const stopped = await f.service.abort(view.id);
    assert.equal(stopped.stopping, true);
    assert.ok(f.service.hasActiveWork());
    assert.ok(existsSync(first.options.scope));
    assert.throws(() => f.service.message(view.id, 'Too soon'), /busy/);
    await assert.rejects(f.service.create({ definition: draft() }), /Too many/);
    first.options.emit({ type: 'context_usage', used: 1, window: 100, spend: { tokens: 30, cached: 0, costUSD: 0.3, models: [] } });
    assert.equal(f.service.view(view.id).spend!.costUSD, 0.3);
    release();
    await wait(() => !f.service.view(view.id).stopping);
    assert.equal(f.service.view(view.id).spend!.costUSD, 0.4);
    f.service.message(view.id, 'Continue');
    await wait(() => f.sessions.length === 2);
    const second = f.sessions[1]!;
    assert.equal(second.options.priorSpend!.costUSD, 0.4);
    second.session.dispose = () => new Promise<void>(resolve => { releaseClose = resolve; });
    let closed = false;
    const closing = f.service.close(view.id).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(closed, false);
    assert.ok(existsSync(second.options.scope));
    assert.ok(f.service.hasActiveWork());
    await assert.rejects(f.service.create({ definition: draft() }), /Too many/);
    const shutdown = f.service.shutdown();
    releaseClose();
    await Promise.all([closing, shutdown]);
    assert.ok(!existsSync(second.options.scope));
    assert.ok(!f.service.hasActiveWork());
  } finally { release(); releaseClose(); await f.cleanup(); }
});

it('routes use bounded bodies, safe errors and method checks behind an authentication gate', async () => {
  const f = fixture();
  const running = await serve({ host: new SessionHost(), token: 'test', assets: {}, workflowBuilders: f.service });
  const url = running.url + '/api/workflow-builders';
  const request = (path = '', method = 'GET', body?: unknown) => fetch(url + path, { method, headers: { authorization: 'Bearer test' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  try {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer test', origin: 'http://evil.test' } })).status, 403);
    assert.equal((await request()).status, 405);
    assert.equal((await request('', 'POST', '{raw-secret')).status, 400);
    assert.equal((await request('', 'POST', 'x'.repeat(300_001))).status, 413);
    assert.equal((await request('', 'POST', { definition: valid(), extra: 1 })).status, 400);
    const response = await request('', 'POST', { definition: draft() }); assert.equal(response.status, 200);
    const view = await response.json() as { id: string };
    assert.equal((await request('/' + view.id)).status, 200);
    assert.equal((await request('/missing')).status, 404);
    assert.equal((await request('/' + view.id + '/messages', 'POST', { text: 'Build it' })).status, 200);
    assert.equal((await request('/' + view.id + '/messages', 'POST', { text: 'Again' })).status, 409);
    assert.equal((await request('/' + view.id + '/abort', 'POST', { unexpected: 'raw-secret' })).status, 400);
    assert.equal((await request('/' + view.id + '/abort', 'POST', {})).status, 200);
    assert.equal((await request('/' + view.id, 'DELETE')).status, 200);
    assert.equal((await request('/' + view.id)).status, 404);
    assert.equal((await request('/bad%2Fid')).status, 400);
    assert.equal((await request('/' + view.id, 'PUT', {})).status, 405);
  } finally { await running.close(); await f.cleanup(); }
});
