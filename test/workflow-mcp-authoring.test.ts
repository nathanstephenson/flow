import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpSession, McpTool } from '../src/backend/mcp.ts';
import type { McpConnection } from '../src/protocol/mcp.ts';
import { WorkflowMcpAuthoringService, type WorkflowMcpAuthoringOptions } from '../src/daemon/workflow-mcp-authoring.ts';
import { workflowMcpAuthoringRoutes } from '../src/daemon/workflow-mcp-authoring-routes.ts';
import { connectionIdentity } from '../src/daemon/workflow-mcp.ts';

const connection = (id = 'default', enabledByDefault = true): Extract<McpConnection, { transport: 'http' }> => ({ id, name: id, enabledByDefault, transport: 'http', url: `https://${id}.example.test/mcp`, oauth: false, headers: {} });
const tool = (name = 'read', inputSchema: McpTool['definition']['inputSchema'] = { type: 'object', properties: { id: { type: 'string' } } }): McpTool => ({ name: `mcp__default__${name}`, connectionId: 'default', definition: { name, inputSchema }, serverIdentity: 'fixture-server', call: async () => { assert.fail('Discovery must never call a tool'); } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const pause = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await pause(); assert.ok(check()); }

type Fake = { scope: string; connection: McpConnection; isolation: boolean | undefined; opened: number; disposed: number; tools: McpTool[]; failed: boolean; openError?: Error; openWait?: Promise<void>; disposeWait?: Promise<void> };
function fixture(initial: McpConnection[] = [connection(), connection('manual', false)]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-mcp-authoring-')));
  const machine = join(root, 'machine'), project = join(root, 'project'), fallback = join(root, 'fallback');
  for (const path of [machine, project, fallback]) mkdirSync(path);
  let projectRoot: string | undefined = machine;
  let include = [project];
  let connections = initial;
  let isolation = true;
  let credentials: string[] = [];
  let createWait: Promise<void> | undefined;
  let configure: (fake: Fake) => void = () => {};
  const starts: Array<{ scope: string; id: string; isolation: boolean | undefined }> = [];
  const sessions: Fake[] = [];
  const config: WorkflowMcpAuthoringOptions['config'] = { projectRoot: () => projectRoot, projectInclude: () => include, mcpConnections: () => structuredClone(connections), filesystemIsolationEnabled: () => isolation };
  const host = {
    workflowMcpCredentials: () => credentials,
    openWorkflowMcpAuthoring: async (scope: string, id: string, isolated?: boolean) => {
      starts.push({ scope, id, isolation: isolated });
      const chosen = connections.find(connection => connection.id === id)!;
      if (createWait) await createWait;
      const fake: Fake = { scope, connection: structuredClone(chosen), isolation: isolated, opened: 0, disposed: 0, tools: [tool()], failed: false };
      configure(fake);
      sessions.push(fake);
      const session = {
        connections: [fake.connection],
        open: async () => { fake.opened++; if (fake.openWait) await fake.openWait; if (fake.openError) throw fake.openError; },
        status: () => [{ id, state: fake.failed ? 'failed' : 'connected', tools: fake.tools.length }],
        tools: () => fake.tools,
        dispose: async () => { fake.disposed++; if (fake.disposeWait) await fake.disposeWait; },
      };
      return session as unknown as McpSession;
    },
  };
  const service = new WorkflowMcpAuthoringService({ host, config, scope: fallback });
  return { root, machine, project, fallback, service, sessions, starts, config,
    projectRoot: (value: string | undefined) => { projectRoot = value; }, include: (value: string[]) => { include = value; },
    connections: (value: McpConnection[]) => { connections = value; }, isolation: (value: boolean) => { isolation = value; }, credentials: (value: string[]) => { credentials = value; },
    configure: (value: (fake: Fake) => void) => { configure = value; }, createWait: (value: Promise<void>) => { createWait = value; },
    async cleanup() { await service.shutdown(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('explicit Refresh/Retry bypasses completed positive and negative caches but joins in-flight discovery', async () => {
  const f = fixture();
  try {
    f.configure(fake => { fake.failed = true; });
    await assert.rejects(f.service.discover(undefined, 'default'));
    f.configure(() => {});
    await assert.rejects(f.service.discover(undefined, 'default'));
    assert.equal(f.starts.length, 1);
    const fresh = await f.service.discover(undefined, 'default', true);
    assert.equal(fresh.tools.length, 1); assert.equal(f.starts.length, 2);
    const again = await f.service.discover(undefined, 'default');
    assert.deepEqual(again, fresh); assert.equal(f.starts.length, 2);
    let finish!: () => void;
    const opening = new Promise<void>(resolve => { finish = resolve; });
    f.configure(fake => { fake.openWait = opening; });
    const one = f.service.discover(undefined, 'default', true);
    const two = f.service.discover(undefined, 'default', true);
    finish();
    assert.deepEqual(await one, await two); assert.equal(f.starts.length, 3);
  } finally { await f.cleanup(); }
});

test('metadata exposes all connections; discovery selects only one; catalogue selects defaults and cached explicit connections', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.service.connections(), { scope: f.machine, connections: [
      { id: 'default', name: 'default', transport: 'http', enabledByDefault: true },
      { id: 'manual', name: 'manual', transport: 'http', enabledByDefault: false },
    ] });
    assert.equal(f.starts.length, 0);
    const first = await f.service.catalogue();
    assert.deepEqual(first.tools.map(tool => tool.connectionId), ['default']);
    assert.deepEqual(f.starts.map(start => start.id), ['default']);
    const manual = await f.service.discover(undefined, 'manual');
    assert.equal(manual.tools[0]!.identity, connectionIdentity(connection('manual', false)));
    assert.equal('call' in manual.tools[0]!, false);
    assert.equal('definition' in manual.tools[0]!, false);
    const next = await f.service.catalogue();
    assert.deepEqual(next.tools.map(tool => tool.connectionId), ['default', 'manual']);
    await f.service.catalogue();
    assert.equal(f.starts.length, 2);
    assert.ok(f.sessions.every(session => session.opened === 1 && session.disposed === 1));
    assert.ok(!JSON.stringify(next).includes('example.test'));
    assert.equal(f.service.hasActiveWork(), false);
  } finally { await f.cleanup(); }
});

test('opted-in Projects use canonical Scope; no Agent Session is needed; invalid Projects never start a client', async () => {
  const f = fixture();
  try {
    await f.service.discover(f.project, 'manual');
    assert.equal(f.starts[0]!.scope, f.project);
    await assert.rejects(f.service.discover(f.machine, 'default'), /not opted in/);
    f.include([join(f.root, 'missing')]);
    await assert.rejects(f.service.discover(join(f.root, 'missing'), 'default'), /not opted in/);
    assert.equal(f.starts.length, 1);
    f.projectRoot(undefined);
    assert.equal(f.service.connections().scope, f.fallback);
    const alias = join(f.root, 'alias');
    symlinkSync(f.fallback, alias);
    await f.service.discover(undefined, 'default');
    f.include([alias]);
    await f.service.discover(alias, 'default');
    assert.equal(f.starts.at(-1)!.scope, f.fallback);
    await assert.rejects(f.service.discover(undefined, 'unknown'), /Unknown/);
  } finally { await f.cleanup(); }
});

test('singleflight joins explicit discovery and catalogue, and returns independent cached snapshots', async () => {
  const f = fixture();
  const gate = deferred();
  try {
    f.configure(fake => { fake.openWait = gate.promise; });
    const one = f.service.discover(undefined, 'default');
    const two = f.service.discover(undefined, 'default');
    const catalogue = f.service.catalogue();
    await until(() => f.sessions.length === 1);
    assert.equal(f.service.hasActiveWork(), true);
    gate.resolve();
    const [a, b, c] = await Promise.all([one, two, catalogue]);
    assert.deepEqual(a, b); assert.deepEqual(a.tools, c.tools);
    a.tools[0]!.toolName = 'mutated';
    assert.equal((await f.service.discover(undefined, 'default')).tools[0]!.toolName, 'read');
    assert.equal(f.starts.length, 1);
    assert.equal(f.sessions[0]!.disposed, 1);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('cache expires after 60 seconds and invalidates on transport, metadata, credential, Scope and isolation changes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const f = fixture();
  try {
    await f.service.discover(undefined, 'default');
    t.mock.timers.tick(59_999);
    await f.service.discover(undefined, 'default');
    assert.equal(f.starts.length, 1);
    t.mock.timers.tick(2);
    await f.service.discover(undefined, 'default');
    assert.equal(f.starts.length, 2);
    f.connections([{ ...connection(), url: 'https://changed.example.test/mcp' }]);
    const changed = await f.service.discover(undefined, 'default');
    assert.notEqual(changed.tools[0]!.identity, connectionIdentity(connection()));
    f.connections([{ ...connection(), name: 'Renamed' }]);
    assert.equal((await f.service.discover(undefined, 'default')).tools[0]!.connectionName, 'Renamed');
    f.credentials(['new-access-token']);
    await f.service.discover(undefined, 'default');
    f.isolation(false);
    await f.service.discover(undefined, 'default');
    assert.equal(f.starts.at(-1)!.isolation, false);
    f.projectRoot(f.fallback);
    await f.service.discover(undefined, 'default');
    assert.equal(f.starts.at(-1)!.scope, f.fallback);
    assert.equal(f.starts.length, 7);
  } finally { await f.cleanup(); }
});

test('cache separates canonical Scopes and joins aliases without extra connections', async () => {
  const f = fixture();
  try {
    const alias = join(f.root, 'alias'); symlinkSync(f.project, alias);
    f.include([f.project, alias]);
    await f.service.discover(f.project, 'default');
    await f.service.discover(alias, 'default');
    await f.service.discover(undefined, 'default');
    assert.equal(f.starts.length, 2);
    assert.deepEqual(f.starts.map(start => start.scope), [f.project, f.machine]);
  } finally { await f.cleanup(); }
});

test('a failed default and incompatible sibling schema do not hide valid tools; failed startup is cached', async () => {
  const f = fixture([connection('failed'), connection('good')]);
  try {
    f.configure(fake => {
      if (fake.connection.id === 'failed') fake.failed = true;
      else fake.tools = [tool(), tool('incompatible', { type: 'object', unknownKeyword: true })];
    });
    const result = await f.service.catalogue();
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]!.connectionId, 'good');
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some(error => error.connectionId === 'failed' && /Sign in/.test(error.message)));
    assert.ok(result.errors.some(error => error.toolName === 'incompatible' && /unknownKeyword/.test(error.message)));
    await assert.rejects(f.service.discover(undefined, 'failed'), /unavailable/);
    await f.service.catalogue();
    assert.equal(f.starts.length, 2);
    assert.ok(f.sessions.every(session => session.disposed === 1));
  } finally { await f.cleanup(); }
});

test('all unavailable configured defaults get individual diagnostics within the catalogue limit', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => connection(`unavailable${i}`)));
  try {
    f.configure(fake => { fake.failed = true; });
    const result = await f.service.catalogue();
    assert.equal(result.tools.length, 0);
    assert.equal(result.errors.length, 100);
    assert.equal(new Set(result.errors.map(error => error.connectionId)).size, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 192_000);
    await f.service.catalogue();
    assert.equal(f.starts.length, 100);
    assert.ok(f.sessions.every(session => session.disposed === 1));
  } finally { await f.cleanup(); }
});

test('credential-bearing schemas, keys, names and errors are excluded or redacted before truncation', async () => {
  const f = fixture();
  const secret = 'private:credential-with-long-suffix';
  try {
    f.credentials([secret]);
    f.connections([{ ...connection(), name: `service ${secret}` }]);
    assert.ok(!JSON.stringify(f.service.connections()).includes(secret));
    f.configure(fake => { fake.tools = [tool('safe'), tool(secret), tool('schema', { type: 'object', description: encodeURIComponent(secret) }), tool('key', { type: 'object', properties: { [secret]: { type: 'string' } } })]; });
    const result = await f.service.discover(undefined, 'default');
    assert.equal(result.tools.length, 0);
    assert.equal(result.errors.length, 4);
    assert.ok(!JSON.stringify(result).includes(secret));
    f.connections([connection()]);
    const clean = await f.service.discover(undefined, 'default');
    assert.equal(clean.tools.length, 1);
    assert.equal(clean.tools[0]!.toolName, 'safe');
    assert.ok(!JSON.stringify(clean).includes(secret));
    f.connections([connection('throw')]);
    f.configure(fake => { fake.openError = new Error('x'.repeat(590) + secret + ' tail'); });
    await assert.rejects(f.service.discover(undefined, 'throw'), error => {
      assert.ok(!String(error).includes('private'));
      assert.ok((error as Error).message.length <= 600);
      return true;
    });
    assert.equal(f.sessions.at(-1)!.disposed, 1);
  } finally { await f.cleanup(); }
});

test('oversized tools are omitted whole with diagnostics; total catalogue bytes and tool counts are bounded', async () => {
  const f = fixture(Array.from({ length: 8 }, (_, i) => connection(`server${i}`)));
  try {
    f.configure(fake => { fake.tools = [tool('oversized', { type: 'object', description: 'x'.repeat(48_000) }), ...Array.from({ length: 30 }, (_, i) => tool(`valid${i}`, { type: 'object', description: 'x'.repeat(4_000) }))]; });
    const result = await f.service.catalogue();
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 192_000);
    assert.ok(result.tools.length > 0 && result.tools.length < 240);
    assert.ok(result.tools.every(tool => tool.toolName !== 'oversized' && (tool.inputSchema as { description: string }).description.length === 4_000));
    assert.ok(result.errors.some(error => /size limit/.test(error.message)));
    assert.ok(result.errors.some(error => /catalogue limit/.test(error.message)));
    f.connections([connection()]);
    f.configure(fake => { fake.tools = Array.from({ length: 400 }, (_, i) => tool(`tiny${i}`)); });
    const many = await f.service.discover(undefined, 'default');
    assert.equal(many.tools.length, 256);
    assert.ok(many.errors.some(error => /count limit/.test(error.message)));
    assert.ok(Buffer.byteLength(JSON.stringify(many)) <= 192_000);
  } finally { await f.cleanup(); }
});

test('global client concurrency and pending capacity are bounded across requests', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => connection(`server${i}`, false)));
  const gate = deferred();
  try {
    f.configure(fake => { fake.openWait = gate.promise; });
    const requests = Array.from({ length: 100 }, (_, i) => f.service.discover(undefined, `server${i}`));
    await until(() => f.sessions.length === 4);
    assert.equal(f.starts.length, 4);
    const second = Array.from({ length: 29 }, (_, i) => f.service.discover(f.project, `server${i}`));
    await assert.rejects(second.at(-1)!, /capacity exceeded/);
    const settled = Promise.allSettled([...requests, ...second]);
    const closing = f.service.shutdown();
    assert.equal(f.service.hasActiveWork(), true);
    gate.resolve();
    await closing;
    await settled;
    assert.equal(f.starts.length, 4);
    assert.ok(f.sessions.every(session => session.disposed === 1));
    assert.equal(f.service.hasActiveWork(), false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('shutdown owns pending startup, disposes late clients before open, blocks admission and never caches late results', async () => {
  const f = fixture();
  const gate = deferred(), disposal = deferred();
  try {
    f.createWait(gate.promise);
    f.configure(fake => { fake.disposeWait = disposal.promise; });
    const discovery = f.service.discover(undefined, 'manual');
    await until(() => f.starts.length === 1);
    const rejected = assert.rejects(discovery, /stopped/);
    const closing = f.service.shutdown();
    assert.equal(f.service.shutdown(), closing);
    await rejected;
    assert.throws(() => f.service.connections(), /stopped/);
    await assert.rejects(f.service.discover(undefined, 'default'), /stopped/);
    await assert.rejects(f.service.catalogue(), /stopped/);
    gate.resolve();
    await until(() => f.sessions[0]?.disposed === 1);
    assert.equal(f.sessions[0]!.opened, 0);
    assert.equal(f.service.hasActiveWork(), true);
    disposal.resolve();
    await closing;
    assert.equal(f.service.hasActiveWork(), false);
    assert.equal(f.starts.length, 1);
  } finally { gate.resolve(); disposal.resolve(); await f.cleanup(); }
});

test('shutdown disposes an opening client immediately and waits for pending work to stop', async () => {
  const f = fixture();
  const gate = deferred();
  try {
    f.configure(fake => { fake.openWait = gate.promise; });
    const discovery = f.service.discover(undefined, 'default');
    await until(() => f.sessions[0]?.opened === 1);
    const rejected = assert.rejects(discovery, /stopped/);
    const closing = f.service.shutdown();
    await until(() => f.sessions[0]?.disposed === 1);
    await rejected;
    assert.equal(f.service.hasActiveWork(), true);
    gate.resolve();
    await closing;
    assert.equal(f.sessions[0]!.disposed, 1);
    assert.equal(f.service.hasActiveWork(), false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('configuration change cancels pending clients and prevents stale results', async () => {
  const f = fixture();
  const gate = deferred();
  try {
    f.configure(fake => { fake.openWait = gate.promise; });
    const discovery = f.service.discover(undefined, 'default');
    await until(() => f.sessions[0]?.opened === 1);
    const rejected = assert.rejects(discovery, /configuration changed/);
    f.isolation(false);
    f.service.connections();
    await rejected;
    assert.equal(f.sessions[0]!.disposed, 1);
    gate.resolve();
    await until(() => !f.service.hasActiveWork());
    await f.service.discover(undefined, 'default');
    assert.equal(f.starts.length, 2);
    assert.equal(f.starts[1]!.isolation, false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('discovery timeout is ten seconds; cleanup stays owned after the response', async (t) => {
  const f = fixture();
  const gate = deferred();
  try {
    f.configure(fake => { fake.openWait = gate.promise; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const discovery = f.service.discover(undefined, 'default');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.sessions[0]!.opened, 1);
    const rejected = assert.rejects(discovery, /timed out/);
    t.mock.timers.tick(10_000);
    await rejected;
    assert.equal(f.sessions[0]!.disposed, 1);
    assert.equal(f.service.hasActiveWork(), true);
    gate.resolve();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(f.service.hasActiveWork(), false);
    await assert.rejects(f.service.discover(undefined, 'default'), /timed out/);
    assert.equal(f.starts.length, 1);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('stdio metadata does not expose commands or arguments, and explicit discovery uses the direct client only', async () => {
  const f = fixture([{ id: 'local', name: 'Local', enabledByDefault: false, transport: 'stdio', command: '/private/command', args: ['private-argument'] }]);
  try {
    assert.deepEqual(f.service.connections().connections, [{ id: 'local', name: 'Local', transport: 'stdio', enabledByDefault: false }]);
    assert.equal((await f.service.catalogue()).tools.length, 0);
    const result = await f.service.discover(undefined, 'local');
    assert.equal(result.tools[0]!.identity, connectionIdentity(f.config.mcpConnections()[0]!));
    assert.equal(f.sessions[0]!.opened, 1);
    assert.equal(f.sessions[0]!.disposed, 1);
    assert.ok(!JSON.stringify(result).includes('private'));
  } finally { await f.cleanup(); }
});

test('ten-second response bound also covers slow disposal; shutdown waits for that disposal', async (t) => {
  const f = fixture();
  const gate = deferred();
  try {
    f.configure(fake => { fake.disposeWait = gate.promise; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const discovery = f.service.discover(undefined, 'default');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.sessions[0]!.disposed, 1);
    const rejected = assert.rejects(discovery, /timed out/);
    t.mock.timers.tick(10_000);
    await rejected;
    assert.equal(f.service.hasActiveWork(), true);
    const closing = f.service.shutdown();
    gate.resolve();
    await closing;
    assert.equal(f.sessions[0]!.disposed, 1);
    assert.equal(f.service.hasActiveWork(), false);
  } finally { gate.resolve(); await f.cleanup(); }
});

test('startup rejection remains safe and does not create a cached successful discovery', async () => {
  const f = fixture();
  const secret = 'startup-private-credential';
  try {
    const options: WorkflowMcpAuthoringOptions = { scope: f.fallback, config: f.config, host: {
      workflowMcpCredentials: () => [secret],
      openWorkflowMcpAuthoring: async () => { throw new Error(secret + ' startup rejected'); },
    } };
    const service = new WorkflowMcpAuthoringService(options);
    try {
      await assert.rejects(service.discover(undefined, 'default'), error => {
        assert.ok(!String(error).includes(secret));
        return true;
      });
      const result = await service.catalogue();
      assert.equal(result.tools.length, 0);
      assert.equal(result.errors.length, 1);
      assert.ok(!JSON.stringify(result).includes(secret));
    } finally { await service.shutdown(); }
  } finally { await f.cleanup(); }
});

test('routes serve only metadata and explicit discovery; reject extra/repeated query parameters and execution endpoints', async () => {
  const f = fixture();
  const server = createServer(async (request, response) => {
    const handled = await workflowMcpAuthoringRoutes(request, response, new URL(request.url!, 'http://localhost'), f.service);
    if (!handled) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const metadata = await fetch(base + '/api/workflow-mcp');
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json() as { connections: unknown[] }).connections.length, 2);
    assert.equal(f.starts.length, 0);
    const selected = await fetch(base + '/api/workflow-mcp/manual?' + new URLSearchParams({ projectId: f.project }));
    assert.equal(selected.status, 200);
    assert.equal((await selected.json() as { tools: Array<{ connectionId: string }> }).tools[0]!.connectionId, 'manual');
    assert.equal(f.starts[0]!.scope, f.project);
    for (const path of ['/api/workflow-mcp?unknown=1', '/api/workflow-mcp?projectId=a&projectId=b', '/api/workflow-mcp?projectId=', '/api/workflow-mcp?projectId=%00', '/api/workflow-mcp/%2F', '/api/workflow-mcp/manual/call', '/api/workflow-mcp/missing', '/api/workflow-mcp?projectId=unlisted']) {
      assert.equal((await fetch(base + path)).status, 400, path);
    }
    assert.equal((await fetch(base + '/api/workflow-mcp/manual', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/other')).status, 404);
    assert.equal(f.starts.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.cleanup();
  }
});
