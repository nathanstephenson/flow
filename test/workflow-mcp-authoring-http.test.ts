import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionHost } from '../src/daemon/host.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { WorkflowMcpAuthoringService } from '../src/daemon/workflow-mcp-authoring.ts';

test('real HTTP MCP authoring initializes and lists tools using private headers without an Agent Session or tools/call', { timeout: 20_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-authoring-http-')));
  const methods: string[] = [];
  let toolCalls = 0;
  const http = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer private-authoring-token') { response.writeHead(401).end(); return; }
    const mcp = new McpServer({ name: 'authoring-fixture', version: '1' });
    mcp.registerTool('lookup', { inputSchema: {} }, async () => { toolCalls++; return { content: [{ type: 'text', text: 'never called' }] }; });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    void (async () => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const parsed = body ? JSON.parse(body) : undefined;
      if (parsed?.method) methods.push(parsed.method);
      await mcp.connect(transport as import('@modelcontextprotocol/sdk/shared/transport.js').Transport);
      await transport.handleRequest(request, response, parsed);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const config = new ConfigStore(root);
  config.update({ mcp: [{ id: 'remote', name: 'Remote', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, oauth: false, headers: { Authorization: { secret: 'authoring-token' } }, enabledByDefault: true }] });
  const host = new SessionHost({ mcpConnections: config.mcpConnections, resolveSecret: name => { assert.equal(name, 'authoring-token'); return 'Bearer private-authoring-token'; } });
  const authoring = new WorkflowMcpAuthoringService({ host, config, scope: root });
  try {
    const catalogue = await authoring.catalogue();
    assert.equal(catalogue.tools[0]!.toolName, 'lookup');
    assert.equal(catalogue.errors.length, 0);
    assert.ok(methods.includes('initialize')); assert.ok(methods.includes('tools/list'));
    assert.equal(methods.includes('tools/call'), false); assert.equal(toolCalls, 0);
    assert.deepEqual(host.list(), []);
    assert.equal(JSON.stringify(catalogue).includes('private-authoring-token'), false);
    assert.equal(JSON.stringify(catalogue).includes('Authorization'), false);
    const before = methods.length;
    await authoring.catalogue(); assert.equal(methods.length, before);
    await authoring.discover(undefined, 'remote', true); assert.ok(methods.length > before);
    assert.equal(toolCalls, 0);
  } finally {
    await authoring.shutdown(); await host.shutdown();
    await new Promise<void>((done, reject) => { http.close(error => error ? reject(error) : done()); http.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
