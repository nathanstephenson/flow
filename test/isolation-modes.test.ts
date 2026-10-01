import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WorkerBackend } from '../src/backend/worker/index.ts';
import { McpSession, type McpTool } from '../src/backend/mcp.ts';
import type { BackendEvent } from '../src/protocol/events.ts';
import { createCodeExecutors } from '../src/workflows/executors.ts';
import type { ExecutorContext } from '../src/workflows/scheduler.ts';

const root = mkdtempSync(join(tmpdir(), 'flow-isolation-modes-'));
const runtimePath = join(root, 'runtime.cjs');
before(() => execFileSync(process.execPath, ['scripts/build-workflow-runtime.mjs', runtimePath]));
after(() => rmSync(root, { recursive: true, force: true }));
const backendModule = new URL('./backend/worker-fixture.ts', import.meta.url).href;
const connection = {
  id: 'fixture', name: 'Fixture', enabledByDefault: true, transport: 'stdio' as const,
  command: process.execPath, args: ['--experimental-strip-types', resolve('test/fixtures/mcp-isolation-server.ts')],
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(root, 'fixture-'));
  const scope = join(directory, 'scope'), stateDir = join(directory, 'backend');
  mkdirSync(scope); mkdirSync(stateDir);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, scope, stateDir };
}
function missingEnforcement(t: TestContext) {
  const saved = process.env.FLOW_BWRAP_PATH;
  process.env.FLOW_BWRAP_PATH = join(root, 'missing-bwrap');
  t.after(() => {
    if (saved === undefined) delete process.env.FLOW_BWRAP_PATH;
    else process.env.FLOW_BWRAP_PATH = saved;
  });
}
function context(scope: string): ExecutorContext {
  return { sessionId: 's', executionId: 'e', scope, input: { value: 4 }, permission: 'auto-accept',
    step: { id: 'a', name: 'a', kind: 'shell', command: 'true' }, signal: new AbortController().signal };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// All write/delete targets in these tests belong to our temporary fixtures, never the host.
test('unrestricted worker skips enforcement/assets, preserves host SDK environment/state and canonical Scope', async t => {
  missingEnforcement(t);
  const f = fixture(t), alias = join(f.directory, 'scope-alias');
  symlinkSync(f.scope, alias, 'dir');
  const sentinel = join(f.directory, 'outside-sentinel');
  writeFileSync(sentinel, 'intact');
  const module = join(f.directory, 'backend.mjs');
  writeFileSync(module, `import fixture from ${JSON.stringify(backendModule)};
import fs from 'node:fs';
export default { name: 'fixture', async create(options) {
  fs.writeFileSync(${JSON.stringify(sentinel)}, 'written');
  const written = fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8');
  fs.unlinkSync(${JSON.stringify(sentinel)});
  options.emit({ type: 'message', id: 'launch', final: true, text: JSON.stringify({
    scope: options.scope, stateDir: options.stateDir, written,
    credential: process.env.FLOW_TEST_CREDENTIAL, home: process.env.HOME,
    pi: process.env.PI_CODING_AGENT_DIR, claude: process.env.CLAUDE_CONFIG_DIR,
    modeInPayload: Object.hasOwn(options, 'isolationEnabled')
  }) });
  return fixture.create(options);
} };
`);
  let enabled = false, snapshots = 0;
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule: pathToFileURL(module).href,
    isolationEnabled: () => { snapshots++; return enabled; },
    readablePaths: ['/missing-assets-should-not-be-discovered'], stateRoot: f.directory,
    env: { FLOW_TEST_CREDENTIAL: 'normal-host-secret', HOME: f.directory,
      PI_CODING_AGENT_DIR: f.directory, CLAUDE_CONFIG_DIR: f.directory } });
  const session = await backend.create({ scope: alias, stateDir: f.stateDir, emit: event => events.push(event) });
  try {
    assert.equal(snapshots, 1);
    const event = events.find(event => event.type === 'message' && event.id === 'launch');
    assert.ok(event?.type === 'message');
    assert.deepEqual(JSON.parse(event.text), { scope: realpathSync(f.scope), stateDir: f.stateDir,
      written: 'written', credential: 'normal-host-secret', home: f.directory,
      pi: f.directory, claude: f.directory, modeInPayload: false });
    assert.equal(existsSync(sentinel), false);
    enabled = true;
    await session.setModel('new-model');
    assert.equal(session.resumeToken(), 'new-model');
    assert.equal(snapshots, 1, 'running workers do not re-read Settings');
  } finally { await session.dispose(); }
  assert.equal(readFileSync(join(f.scope, 'disposed'), 'utf8'), 'yes');
});

test('unrestricted worker keeps reverse MCP/Workflow IPC and owned Subagent handles', async t => {
  missingEnforcement(t);
  const f = fixture(t);
  let calls = 0, inspections = 0;
  const tool: McpTool = { name: 'mcp__fixture__tool', connectionId: 'fixture', serverIdentity: 'fixture',
    definition: { name: 'tool', inputSchema: { type: 'object' } }, call: async (input, signal, timeout) => {
      assert.deepEqual(input, { fixture: true }); assert.ok(signal instanceof AbortSignal); assert.equal(timeout, 1234);
      calls++; return { content: [{ type: 'text', text: 'host result' }] };
    } };
  const session = await new WorkerBackend({ backendModule, isolationEnabled: () => false }).create({
    scope: f.scope, emit: () => {}, mcp: { tools: () => [tool] } as McpSession,
    workflow: { inspect: async () => { inspections++; return null; }, recover: async () => null,
      relayEnquiry: async () => null, relayPermission: async () => null },
  });
  try {
    await session.prompt('mcp'); await session.prompt('workflow');
    assert.equal(calls, 1); assert.equal(inspections, 1);
    let activity = 0;
    const options = { id: 'workflow', name: 'fixture', instructions: 'finish', input: null,
      modelId: 'fixture', effort: 'off' as const, permissionMode: 'ask' as const, emit: () => { activity++; } };
    assert.equal(await session.startWorkflowSubagent!(options).done, 'finished');
    assert.equal(activity, 1);
    const handle = session.startWorkflowSubagent!({ ...options, instructions: 'wait' });
    assert.equal(await handle.answerPermission('permission', 'allow'), true);
    assert.equal(await handle.done, 'allowed');
    const cancelled = session.startWorkflowSubagent!({ ...options, instructions: 'wait' });
    const rejected = assert.rejects(cancelled.done, /workflow cancelled/);
    await cancelled.cancel(); await rejected;
  } finally { await session.dispose(); }
});

test('unrestricted worker initialization failures still dispose the owned process', async t => {
  missingEnforcement(t);
  const f = fixture(t);
  const backend = new WorkerBackend({ backendModule, isolationEnabled: () => false, shutdownTimeoutMs: 100 });
  await assert.rejects(backend.create({ scope: f.scope, modelId: 'create-error', emit: () => {} }), /fixture create failed/);
  await assert.rejects(new WorkerBackend({ backendModule, isolationEnabled: () => false, startupTimeoutMs: 100, shutdownTimeoutMs: 100 })
    .create({ scope: f.scope, modelId: 'create-hang', emit: () => {} }), /cancelled/i);
  const file = join(f.directory, 'not-a-directory'); writeFileSync(file, 'x');
  await assert.rejects(backend.create({ scope: file, emit: () => {} }), /Scope must be a directory/);
});

test('unrestricted stdio MCP skips policy, permits outside-Scope write/delete, retries and disposes', async t => {
  missingEnforcement(t);
  const f = fixture(t), alias = join(f.directory, 'alias');
  symlinkSync(f.scope, alias, 'dir');
  const sentinel = join(f.directory, 'sentinel'); writeFileSync(sentinel, 'intact');
  const mcp = new McpSession([connection], alias, undefined, false, undefined, [f.directory], f.directory, false);
  try {
    await mcp.open();
    assert.equal(mcp.status()[0]?.state, 'connected');
    const result = await mcp.tools().find(tool => tool.definition.name === 'attack')!.call({ targets: [sentinel] });
    const text = result.content[0]; assert.ok(text?.type === 'text');
    assert.deepEqual(JSON.parse(text.text), { results: ['allowed', 'allowed'], descendant: ['allowed', 'allowed'] });
    assert.equal(existsSync(sentinel), false);
    assert.equal(readFileSync(join(f.scope, 'scope-write'), 'utf8'), 'allowed');
    await mcp.retry(connection.id);
    assert.equal(mcp.status()[0]?.state, 'connected');
  } finally { await mcp.dispose(); }
  assert.deepEqual(mcp.tools(), []);
  await assert.rejects(mcp.retry(connection.id), /stopped/);
});

test('unrestricted MCP still uses the minimal SDK environment and handles failed discovery', async t => {
  missingEnforcement(t);
  const f = fixture(t);
  const script = join(f.directory, 'server.mjs');
  writeFileSync(script, `import fs from 'node:fs';
fs.writeFileSync('environment', JSON.stringify({ leaked: process.env.FLOW_TEST_CREDENTIAL ?? null, cwd: process.cwd() }));
process.exit(1);
`);
  const saved = process.env.FLOW_TEST_CREDENTIAL;
  process.env.FLOW_TEST_CREDENTIAL = 'host-only-secret';
  const mcp = new McpSession([{ ...connection, args: [script] }], f.scope, undefined, false, undefined, undefined, undefined, false);
  try {
    await mcp.open();
    assert.equal(mcp.status()[0]?.state, 'failed');
    assert.deepEqual(JSON.parse(readFileSync(join(f.scope, 'environment'), 'utf8')), { leaked: null, cwd: realpathSync(f.scope) });
  } finally {
    await mcp.dispose();
    if (saved === undefined) delete process.env.FLOW_TEST_CREDENTIAL; else process.env.FLOW_TEST_CREDENTIAL = saved;
  }
});

test('unrestricted Workflow Shell and QuickJS invocation work without enforcement or filesystem policy', async t => {
  missingEnforcement(t);
  const f = fixture(t), alias = join(f.directory, 'alias'); symlinkSync(f.scope, alias, 'dir');
  const sentinel = join(f.directory, 'sentinel'); writeFileSync(sentinel, 'intact');
  const saved = process.env.FLOW_TEST_CREDENTIAL; process.env.FLOW_TEST_CREDENTIAL = 'must-not-leak';
  try {
    // Deliberately inside a protected host-state fixture: false must not apply restricted Scope policy.
    const executors = await createCodeExecutors({ runtimePath, nodePath: process.execPath, scope: alias,
      stateRoot: f.directory, isolationEnabled: false });
    const ctx = context(alias);
    ctx.step = { id: 'a', name: 'a', kind: 'shell', command: `printf written > ${quote(sentinel)}; cat ${quote(sentinel)}; rm ${quote(sentinel)}; printf '%s' "\${FLOW_TEST_CREDENTIAL-unset}" >&2; pwd` };
    assert.deepEqual(await executors.shell.execute(ctx), { exitCode: 0, stdout: `written${realpathSync(f.scope)}\n`, stderr: 'unset' });
    assert.equal(existsSync(sentinel), false);
    ctx.step = { id: 'a', name: 'a', kind: 'typescript', code: 'await fs.writeText("result", "value"); return 7;', outputSchema: { type: 'number' } };
    assert.equal(await executors.typescript.execute(ctx), 7);
    assert.equal(readFileSync(join(f.scope, 'result'), 'utf8'), 'value');
    // QuickJS API restrictions remain independent of the optional host filesystem boundary.
    ctx.step.code = 'return process.pid;';
    await assert.rejects(executors.typescript.execute(ctx));
    ctx.step = { id: 'a', name: 'a', kind: 'shell', command: 'while true; do sleep 0.1; done', timeoutMs: 100 };
    await assert.rejects(executors.shell.execute(ctx), /stopped/);
  } finally {
    if (saved === undefined) delete process.env.FLOW_TEST_CREDENTIAL; else process.env.FLOW_TEST_CREDENTIAL = saved;
  }
});

test('unrestricted Node readiness is absolute, version checked, asynchronous and timeout bounded', { timeout: 10000 }, async t => {
  missingEnforcement(t);
  const f = fixture(t);
  const old = join(f.directory, 'old-node'), slow = join(f.directory, 'slow-node');
  writeFileSync(old, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  writeFileSync(slow, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  try {
    for (const nodePath of ['node', join(f.directory, 'missing-node'), old, slow]) {
      const executors = await createCodeExecutors({ runtimePath, nodePath, isolationEnabled: false });
      assert.throws(() => executors.shell.check(context(f.scope).step, { sessionId: 's', scope: f.scope, backend: 'pi' }), /Host Node 22 or later/);
    }
    assert.ok(ticks >= 10, 'Node probes must not block Session Host heartbeat');
  } finally { clearInterval(timer); }
});

test('explicit enabled and omitted library defaults fail closed on missing enforcement', async t => {
  missingEnforcement(t);
  const f = fixture(t), marker = join(f.scope, 'launched');
  for (const isolationEnabled of [undefined, () => true]) {
    await assert.rejects(new WorkerBackend({ backendModule, ...(isolationEnabled ? { isolationEnabled } : {}) })
      .create({ scope: f.scope, emit: () => {} }), /unrestricted launch refused/);
  }
  for (const enabled of [true, undefined]) {
    const mcp = new McpSession([{ ...connection, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`] }],
      f.scope, undefined, false, undefined, undefined, undefined, enabled);
    try { await mcp.open(); assert.equal(mcp.status()[0]?.state, 'failed'); }
    finally { await mcp.dispose(); }
    const executors = await createCodeExecutors({ runtimePath, nodePath: process.execPath,
      ...(enabled !== undefined ? { isolationEnabled: enabled } : {}) });
    const ctx = context(f.scope); ctx.step = { id: 'a', name: 'a', kind: 'shell', command: 'touch launched' };
    await assert.rejects(executors.shell.execute(ctx), /unrestricted launch refused/);
  }
  assert.equal(existsSync(marker), false);
});

test('HTTP MCP is unchanged in either isolation mode, even with missing enforcement and no local Scope', async t => {
  missingEnforcement(t);
  const server = createServer((request, response) => {
    const mcp = new McpServer({ name: 'http-fixture', version: '1' });
    mcp.registerTool('hello', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'remote' }] }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    void mcp.connect(transport as import('@modelcontextprotocol/sdk/shared/transport.js').Transport)
      .then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const enabled of [true, false]) {
      const mcp: McpSession = new McpSession([{ id: 'remote', name: 'Remote', transport: 'http', enabledByDefault: true,
        url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, oauth: false }], '/not-a-local-scope',
        undefined, false, undefined, undefined, undefined, enabled);
      try {
        await mcp.open(); assert.equal(mcp.status()[0]?.state, 'connected');
        assert.deepEqual((await mcp.tools()[0]!.call({})).content, [{ type: 'text', text: 'remote' }]);
      } finally { await mcp.dispose(); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
