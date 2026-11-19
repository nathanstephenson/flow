import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WorkerBackend } from '../../src/backend/worker/index.ts';
import { SandboxMcpSession } from '../../src/backend/worker/sandbox-mcp.ts';
import { SharedSandbox } from '../../src/isolation/shared-sandbox.ts';
import { SessionHost } from '../../src/daemon/host.ts';
import { fakeProvider } from './sandbox-fixture.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

for (const cancellation of ['dispose', 'signal'] as const) {
  test(`Sandbox discovery ${cancellation} stops only its view after worker initialization`, { timeout: 15_000 }, async t => {
    const requested = deferred(), release = deferred();
    let calls = 0;
    const remote = createServer((request, response) => {
      const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        requested.resolve();
        await release.promise;
        return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        calls++;
        return { content: [{ type: 'text', text: 'parallel' }] };
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      response.once('close', () => { void server.close(); });
      void server.connect(transport as import('@modelcontextprotocol/sdk/shared/transport.js').Transport).then(() => transport.handleRequest(request, response));
    });
    await new Promise<void>(done => remote.listen(0, '127.0.0.1', done));
    t.after(() => { release.resolve(); remote.closeAllConnections(); remote.close(); });
    const address = remote.address();
    assert.ok(address && typeof address !== 'string');
    let cleanup = async () => {};
    t.after(() => cleanup());
    const f = fakeProvider(t);
    const shared = new SharedSandbox(f.stateRoot, () => f.scope);
    const mcp = new SandboxMcpSession([{ id: 'remote', name: 'Remote', transport: 'http', enabledByDefault: true,
      url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, oauth: false }], f.scope);
    const directRequested = deferred();
    const attach = mcp.attach.bind(mcp);
    t.mock.method(mcp, 'attach', (worker: Parameters<SandboxMcpSession['attach']>[0]) => attach((method, args, signal) => {
      const result = worker(method, args, signal);
      if (method === 'mcp.direct') directRequested.resolve();
      return result;
    }));
    const backend = new WorkerBackend({ entry: resolve('src/backend/worker/entry.ts'),
      backendModule: new URL('./worker-fixture.ts', import.meta.url).href, stateRoot: f.stateRoot,
      isolationMode: () => 'sandbox', sandbox: () => f.support, sharedSandbox: () => shared });
    const session = await backend.create({ scope: f.scope, stateDir: f.state, mcp, emit: () => {} });
    cleanup = async () => { release.resolve(); await session.dispose(); await shared.close(); };
    await bounded(requested.promise);
    const controller = new AbortController();
    const direct = await mcp.directView('remote', controller.signal);
    const parallel = await mcp.directView('remote');
    let effects = 0;
    const discovering = direct.open().then(() => { effects++; });
    const rejected = assert.rejects(discovering, /cancel|abort|stopped/i);
    const parallelDiscovery = parallel.open();
    await bounded(directRequested.promise);
    if (cancellation === 'dispose') await direct.dispose(); else controller.abort();
    await bounded(rejected);
    assert.equal(effects, 0);
    assert.equal(f.calls().filter(call => call.startsWith('remove ')).length, 0);
    release.resolve();
    await bounded(parallelDiscovery);
    assert.equal(parallel.status()[0]?.state, 'connected');
    assert.equal(effects, 0);
    assert.deepEqual(direct.tools(), []);
    await assert.rejects(direct.open(), /cancel|abort|stopped/i);
    const tool = parallel.tools()[0]!;
    assert.deepEqual((await bounded(tool.call({}))).content, [{ type: 'text', text: 'parallel' }]);
    await parallel.dispose();
    await assert.rejects(tool.call({}), /cancel|abort|stopped/i);
    assert.equal(calls, 1);
    assert.equal(f.calls().filter(call => call === 'create').length, 1);
    assert.equal(f.calls().filter(call => call.startsWith('remove ')).length, 0);
  });
}

test('host discovery cancellation stops waiting for Backend Session initialization', { timeout: 5000 }, async t => {
  const host = new SessionHost();
  const requested = deferred(), initialized = deferred();
  t.mock.method(host, 'openWorkflowSession', async () => {
    requested.resolve();
    await initialized.promise;
    return { sessionId: 'fixture', backend: 'fixture', scope: '/', projectId: '/', session: undefined };
  });
  const controller = new AbortController();
  const opening = host.openWorkflowMcp('fixture', 'remote', 'sandbox', controller.signal);
  const rejected = assert.rejects(opening, /abort/i);
  await requested.promise;
  controller.abort();
  await bounded(rejected);
  initialized.resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(host.list(), []);
});

test('Sandbox direct view cancellation stops waiting for worker attachment', { timeout: 5000 }, async () => {
  const mcp = new SandboxMcpSession([{ id: 'remote', name: 'Remote', transport: 'http', enabledByDefault: true,
    url: 'http://127.0.0.1:1/mcp', headers: {}, oauth: false }], '/');
  const controller = new AbortController();
  const pending = mcp.directView('remote', controller.signal);
  const rejected = assert.rejects(pending, /abort/i);
  controller.abort();
  await bounded(rejected);
  let calls = 0;
  mcp.attach(async () => { calls++; });
  assert.equal(calls, 0);
});
