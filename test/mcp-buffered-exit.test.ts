import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SupervisedStdioTransport } from '../src/backend/mcp-stdio-supervisor.ts';

// Synchronously flush a complete frame, then exit without waiting for the client's
// reader. Unlike an async stdout callback fixture, this reliably exposes exit-vs-IO
// scheduling races under concurrent actual MCP initialize/list/call traffic.
test('stdio drains buffered final MCP replies before reporting leader exit', { timeout: 60000 }, async t => {
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
  for (let round = 0; round < 4; round++) {
    const results = await Promise.allSettled(Array.from({ length: 32 }, async () => {
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
});
