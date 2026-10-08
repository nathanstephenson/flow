import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { McpSession } from '../src/backend/mcp.ts';
import { SupervisedStdioTransport } from '../src/backend/mcp-stdio-supervisor.ts';
import { prepareFilesystemIsolation } from '../src/isolation/filesystem.ts';

const linux = process.platform === 'linux';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function identity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
function descriptors(root: string): string[] {
  return readdirSync('/proc/self/fd').flatMap(fd => {
    try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${root}/`) ? [fd] : []; }
    catch { return []; }
  });
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-mcp-scope-'));
  const scope = join(root, 'scope'), original = join(root, 'original');
  mkdirSync(scope);
  const expected = identity(scope);
  const script = join(root, 'server.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const stat = fs.statSync('.', {bigint:true});
fs.writeFileSync('launched', stat.dev+':'+stat.ino);
setInterval(()=>{},1000);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize' ? {protocolVersion:msg.params.protocolVersion,
    capabilities:{tools:{}},serverInfo:{name:'scope-fixture',version:'1'}}
    : msg.method === 'tools/list' ? {tools:[]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});
`);
  const connection = { id: 'scope', name: 'Scope', transport: 'stdio' as const,
    command: process.execPath, args: [script], enabledByDefault: true };
  const session = (isolated = false, command = connection.command) => {
    const mcp = new McpSession([{ ...connection, command }], scope, undefined, true,
      undefined, undefined, undefined, isolated, expected);
    t.after(() => mcp.dispose({ waitForExit: true }));
    return mcp;
  };
  const replace = () => { renameSync(scope, original); mkdirSync(scope); };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, scope, original, expected, session, replace };
}

test('authoring refuses a directory replaced before unrestricted descriptor validation', { skip: !linux }, async t => {
  const f = fixture(t), mcp = f.session();
  f.replace();
  await assert.rejects(mcp.open(), /Refresh the selected Scope/);
  assert.equal(mcp.status()[0]?.state, 'failed');
  assert.equal(existsSync(join(f.scope, 'launched')), false);
  assert.equal(existsSync(join(f.original, 'launched')), false);
  assert.deepEqual(descriptors(f.root), []);
});

test('unrestricted authoring cwd uses the validated descriptor when Scope changes at startup', { skip: !linux }, async t => {
  const f = fixture(t), mcp = f.session();
  const start = SupervisedStdioTransport.prototype.start;
  t.mock.method(SupervisedStdioTransport.prototype, 'start', async function (this: SupervisedStdioTransport) {
    assert.equal(descriptors(f.root).length, 1);
    f.replace();
    await start.call(this);
  });
  await mcp.open();
  assert.equal(mcp.status()[0]?.state, 'connected');
  assert.equal(readFileSync(join(f.original, 'launched'), 'utf8'), f.expected);
  assert.equal(existsSync(join(f.scope, 'launched')), false);
  await mcp.dispose({ waitForExit: true });
  assert.deepEqual(descriptors(f.root), []);
});

test('authoring keeps its cwd descriptor after bounded close until actual exit', { skip: !linux }, async t => {
  const f = fixture(t), mcp = f.session();
  const close = SupervisedStdioTransport.prototype.close;
  let transport: SupervisedStdioTransport | undefined;
  t.mock.method(SupervisedStdioTransport.prototype, 'close', async function (this: SupervisedStdioTransport) { transport = this; });
  try {
    await mcp.open();
    await mcp.dispose();
    assert.equal(descriptors(f.root).length, 1);
    let settled = false;
    const owned = mcp.dispose({ waitForExit: true }).then(() => { settled = true; });
    await delay(25);
    assert.equal(settled, false);
    assert.ok(transport);
    await close.call(transport);
    await owned;
    assert.deepEqual(descriptors(f.root), []);
  } finally { if (transport) await close.call(transport); }
});

test('authoring Retry refuses replaced Scope and releases the prior descriptor', { skip: !linux }, async t => {
  const f = fixture(t), mcp = f.session();
  await mcp.open();
  assert.equal(descriptors(f.root).length, 1);
  f.replace();
  await assert.rejects(mcp.retry('scope'), /Refresh the selected Scope/);
  assert.equal(existsSync(join(f.scope, 'launched')), false);
  await mcp.dispose({ waitForExit: true });
  assert.deepEqual(descriptors(f.root), []);
});

test('authoring spawn failure releases the validated cwd descriptor', { skip: !linux }, async t => {
  const f = fixture(t), mcp = f.session(false, join(f.root, 'missing-command'));
  await assert.rejects(mcp.open(), /MCP authoring launch failed/);
  await mcp.dispose({ waitForExit: true });
  assert.deepEqual(descriptors(f.root), []);
});

test('non-Linux authoring fails closed but ordinary unrestricted MCP keeps working', { skip: !linux }, async t => {
  const f = fixture(t), authoring = f.session();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let lookups = 0;
  const realpath = t.mock.method(fs, 'realpathSync', () => { lookups++; return f.scope; });
  const stat = t.mock.method(fs, 'statSync', () => { lookups++; return { isDirectory: () => true } as ReturnType<typeof statSync>; });
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await assert.rejects(authoring.open(), /requires Linux; launch refused/);
    assert.equal(lookups, 0, 'unsupported authoring must refuse before filesystem metadata I/O');
    realpath.mock.restore(); stat.mock.restore(); syncBuiltinESMExports();
    assert.equal(existsSync(join(f.scope, 'launched')), false);
    const ordinary = new McpSession([{ id: 'ordinary', name: 'Ordinary', enabledByDefault: true,
      transport: 'stdio', command: process.execPath, args: [join(f.root, 'server.cjs')] }], f.scope,
      undefined, false, undefined, undefined, undefined, false);
    try {
      await ordinary.open();
      assert.equal(ordinary.status()[0]?.state, 'connected');
    } finally { await ordinary.dispose({ waitForExit: true }); }
  } finally {
    realpath.mock.restore(); stat.mock.restore(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
  }
  assert.deepEqual(descriptors(f.root), []);
});

test('isolation checks the exact expected identity on its pinned Scope fd during preparation', { skip: !linux }, async t => {
  const f = fixture(t);
  const preparing = prepareFilesystemIsolation({ scope: f.scope, expectedScope: f.scope,
    expectedScopeIdentity: f.expected, command: process.execPath, args: [], credentials: 'none',
    env: { FLOW_BWRAP_PATH: '/bin/true', PATH: '/usr/bin:/bin' } });
  f.replace();
  await assert.rejects(preparing, /Scope changed since selection; refusing replaced directory/);
  assert.deepEqual(descriptors(f.root), []);
});

test('isolated authoring launches the validated Scope fd after directory replacement at startup', { skip: !linux, timeout: 30000 }, async t => {
  try {
    (await prepareFilesystemIsolation({ scope: process.cwd(), command: process.execPath,
      args: [], credentials: 'none' })).cleanup();
  } catch (error) { t.skip(`Filesystem isolation unavailable: ${(error as Error).message}`); return; }
  const f = fixture(t), mcp = f.session(true);
  const start = SupervisedStdioTransport.prototype.start;
  t.mock.method(SupervisedStdioTransport.prototype, 'start', async function (this: SupervisedStdioTransport) {
    assert.ok(descriptors(f.root).some(fd => identity(`/proc/self/fd/${fd}`) === f.expected));
    f.replace();
    await start.call(this);
  });
  await mcp.open();
  assert.equal(mcp.status()[0]?.state, 'connected');
  assert.equal(readFileSync(join(f.original, 'launched'), 'utf8'), f.expected);
  assert.equal(existsSync(join(f.scope, 'launched')), false);
  await mcp.dispose({ waitForExit: true });
  assert.deepEqual(descriptors(f.root), []);
});
