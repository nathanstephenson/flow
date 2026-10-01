import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSession } from '../src/backend/mcp.ts';
import { SupervisedStdioTransport } from '../src/backend/mcp-stdio-supervisor.ts';

const posix = process.platform !== 'win32';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Lifecycle operation exceeded ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  // Orphan zombies can remain until the test container's init reaps them. They cannot run
  // or hold pipes. On macOS the ordinary kill(0) check suffices (launchd reaps orphans).
  if (process.platform === 'linux') {
    try { if (/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; }
    catch { return false; }
  }
  return true;
}
async function dead(pids: number[]) {
  for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) await delay(20);
  assert.deepEqual(pids.filter(alive), [], 'owned server and ordinary descendants must stop');
}

function fixture(t: TestContext, mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'flow-mcp-lifecycle-'));
  const scope = join(root, 'scope'); mkdirSync(scope);
  const script = join(root, 'server.cjs');
  // All test processes/markers belong to this temporary fixture. Both stdout and stderr
  // are inherited by the child; it ignores EOF and SIGTERM. No SDK private APIs are used.
  writeFileSync(script, `
const fs = require('node:fs'), { spawn } = require('node:child_process');
const mode = ${JSON.stringify(mode)};
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
  { detached: mode === 'escaped' || mode === 'escaped-exit', stdio: ['ignore', 1, 2] });
fs.appendFileSync('pids', JSON.stringify([process.pid, child.pid])+'\\n');
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
if (mode === 'exit' || mode === 'escaped-exit') setTimeout(()=>process.exit(1),100);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion,
    capabilities:{tools:{}}, serverInfo:{name:'lifecycle-fixture',version:'1'} };
  else if (msg.method === 'tools/list') result = {tools:[{name:'wait',inputSchema:{type:'object'}}],
    ...(mode === 'discovery-failure' ? {nextCursor:'repeated'} : {})};
  else if (msg.method === 'tools/call') return;
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});
`);
  const pids = () => existsSync(join(scope, 'pids'))
    ? readFileSync(join(scope, 'pids'), 'utf8').trim().split('\n').flatMap(line => JSON.parse(line) as number[])
    : [];
  let hostPids = true;
  t.after(async () => {
    // Namespace PIDs must never be interpreted as host PIDs. Also clean deliberately
    // escaped unrestricted descendants and regression failures.
    for (const pid of hostPids ? pids() : []) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const connection = { id: 'fixture', name: 'Fixture', enabledByDefault: true,
    transport: 'stdio' as const, command: process.execPath, args: [script] };
  const session = (isolated = false) => {
    hostPids = !isolated;
    const mcp = new McpSession([connection], scope, undefined, false, undefined, undefined, undefined, isolated);
    t.after(() => within(mcp.dispose()));
    return mcp;
  };
  return { root, scope, connection, pids, session };
}

test('unrestricted stdio disposal kills non-detached children inheriting stdout AND stderr', { skip: !posix }, async t => {
  const f = fixture(t), mcp = f.session();
  await within(mcp.open());
  assert.equal(mcp.status()[0]?.state, 'connected');
  assert.equal(f.pids().length, 2);
  const start = Date.now();
  await within(mcp.dispose());
  assert.ok(Date.now() - start < 2500, 'uncooperative disposal is bounded');
  await dead(f.pids());
  assert.deepEqual(mcp.tools(), []);
  await assert.rejects(mcp.retry('fixture'), /stopped/);
});

test('Retry tears down the previous stdio process group before launching its replacement', { skip: !posix }, async t => {
  const f = fixture(t), mcp = f.session();
  await within(mcp.open());
  const first = f.pids();
  await within(mcp.retry('fixture'));
  await dead(first);
  assert.equal(mcp.status()[0]?.state, 'connected');
  assert.equal(f.pids().length, 4);
  assert.ok(f.pids().slice(2).every(alive));
  await within(mcp.dispose());
  await dead(f.pids());
});

test('failed discovery releases the server and inherited-pipe children, including Retry', { skip: !posix }, async t => {
  const f = fixture(t, 'discovery-failure'), mcp = f.session();
  await within(mcp.open());
  assert.equal(mcp.status()[0]?.state, 'failed');
  await dead(f.pids());
  await within(mcp.retry('fixture'));
  assert.equal(f.pids().length, 4);
  await dead(f.pids());
  await within(mcp.dispose());
});

test('spontaneous leader exit does not wait for descendant pipe EOF and cleans its group', { skip: !posix }, async t => {
  const f = fixture(t, 'exit'), mcp = f.session();
  await within(mcp.open());
  await dead(f.pids());
  for (let i = 0; i < 100 && mcp.status()[0]?.state !== 'failed'; i++) await delay(20);
  assert.equal(mcp.status()[0]?.state, 'failed');
  await within(mcp.dispose());
});

test('detached unrestricted pipe holders cannot hang disposal (not a confinement promise)', { skip: !posix }, async t => {
  const f = fixture(t, 'escaped'), mcp = f.session();
  await within(mcp.open());
  await within(mcp.dispose());
  await dead([f.pids()[0]!]);
  // The escaped child is explicitly cleaned by the fixture, not falsely claimed contained.
});

test('spontaneous leader exit bounds stdout draining even with a detached pipe holder', { skip: !posix }, async t => {
  const f = fixture(t, 'escaped-exit');
  const transport = new SupervisedStdioTransport({ command: f.connection.command, args: f.connection.args, env: process.env, cwd: f.scope });
  t.after(() => transport.close());
  await within(transport.start());
  await within(transport.exited);
  assert.equal(f.pids().length, 2);
  await dead([f.pids()[0]!]);
  assert.ok(alive(f.pids()[1]!), 'the fixture, not the supervisor, owns the deliberately escaped child');
  await within(transport.close());
});

test('missing stdio executable resolves actual-exit supervision and supports bounded Retry', async t => {
  const f = fixture(t);
  const transport = new SupervisedStdioTransport({ command: join(f.root, 'missing'), args: [], env: {}, cwd: f.scope });
  await assert.rejects(within(transport.start()), /ENOENT/);
  await within(transport.close());
  await within(transport.exited);
  const mcp = new McpSession([{ ...f.connection, command: join(f.root, 'missing') }], f.scope,
    undefined, false, undefined, undefined, undefined, false);
  t.after(() => within(mcp.dispose()));
  await within(mcp.open());
  assert.equal(mcp.status()[0]?.state, 'failed');
  await within(mcp.retry('fixture'));
  await within(mcp.dispose());
});

test('disposing a transport before start cannot spawn a server later', async t => {
  const f = fixture(t);
  const transport = new SupervisedStdioTransport({ command: f.connection.command, args: f.connection.args, env: {}, cwd: f.scope });
  await within(transport.close());
  await within(transport.exited);
  await assert.rejects(transport.start(), /closed/);
  assert.deepEqual(f.pids(), []);
});

test('cancellation and disposal during an active MCP call do not strand its stdio tree', { skip: !posix }, async t => {
  const f = fixture(t), mcp = f.session();
  await within(mcp.open());
  const abort = new AbortController();
  const call = mcp.tools()[0]!.call({}, abort.signal);
  const rejected = assert.rejects(call, /MCP tool call failed/);
  await assert.rejects(mcp.retry('fixture'), /still running/);
  abort.abort();
  await within(rejected);
  const pending = mcp.tools()[0]!.call({});
  const closed = assert.rejects(pending, /MCP tool call failed/);
  await within(mcp.dispose());
  await within(closed);
  await dead(f.pids());
});

test('isolated stdio uses pinned boundary descriptors with the same bounded lifecycle', {
  skip: process.platform !== 'linux' || !process.env.FLOW_BWRAP_PATH,
}, async t => {
  const f = fixture(t), mcp = f.session(true);
  await within(mcp.open(), 15000);
  assert.equal(mcp.status()[0]?.state, 'connected', 'requested isolation must not silently fall back');
  await within(mcp.retry('fixture'));
  assert.equal(mcp.status()[0]?.state, 'connected');
  await within(mcp.dispose());
});
