import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { mock, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { SupervisedStdioTransport } from '../src/backend/mcp-stdio-supervisor.ts';

test('stdio drains a buffered final reply when exit arrives before stdout data', async t => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const spawn = mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const transport = new SupervisedStdioTransport({ command: 'fixture', args: [], cwd: tmpdir(), env: {} });
  t.after(() => transport.close());
  const events: unknown[] = [];
  transport.onmessage = message => events.push(message);
  transport.onclose = () => events.push('closed');
  await transport.start();
  const reply = { jsonrpc: '2.0' as const, id: 1, result: { content: [{ type: 'text', text: 'x'.repeat(200000) }] } };
  child.stdout.pause();
  child.stdout.end(serializeMessage(reply));
  child.emit('exit', 0, null);
  assert.deepEqual(events, []);
  await transport.exited;
  assert.deepEqual(events, [reply, 'closed']);
});

test('stdio drains final MCP replies through actual pipes', { timeout: 60000 }, t => finalReplies(t, 2, 1));

test('stdio final-reply stress with 32 concurrent clients', {
  skip: process.env.FLOW_MCP_STRESS !== '1' && 'Set FLOW_MCP_STRESS=1 to run the optional stress test',
  timeout: 60000,
}, t => finalReplies(t, 32, 4));

async function finalReplies(t: TestContext, clients: number, rounds: number) {
  const root = mkdtempSync(join(tmpdir(), 'flow-mcp-buffered-exit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'server.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = {protocolVersion:message.params.protocolVersion,
    capabilities:{tools:{}},serverInfo:{name:'buffered-exit',version:'1'}};
  else if (message.method === 'tools/list') result = {tools:[{name:'final',inputSchema:{type:'object'}}]};
  else if (message.method === 'tools/call') result = {content:[{type:'text',text:'x'.repeat(200000)}]};
  else result = {};
  const payload = Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
  for (let offset = 0; offset < payload.length;) {
    try { offset += fs.writeSync(1, payload, offset, payload.length - offset); }
    catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
  if (message.method === 'tools/call') process.exit(0);
});
`);
  for (let round = 0; round < rounds; round++) {
    const results = await Promise.allSettled(Array.from({ length: clients }, async () => {
      const transport = new SupervisedStdioTransport({ command: process.execPath, args: [script], cwd: root, env: process.env });
      const client = new Client({ name: 'buffered-exit-test', version: '1' }, { capabilities: {} });
      try {
        await client.connect(transport);
        assert.equal((await client.listTools()).tools[0]?.name, 'final');
        const result = await client.callTool({ name: 'final', arguments: {} });
        assert.deepEqual(result.content, [{ type: 'text', text: 'x'.repeat(200000) }]);
        await transport.exited;
      } finally {
        await client.close();
        await transport.close();
      }
    }));
    assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => String(result.reason)), []);
  }
}
