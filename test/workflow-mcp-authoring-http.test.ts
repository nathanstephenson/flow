import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionHost } from '../src/daemon/host.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { WorkflowMcpAuthoringService } from '../src/daemon/workflow-mcp-authoring.ts';
import { workflowAuthoringDirectory } from '../src/daemon/workflow-authoring-scope.ts';
import { SupervisedStdioTransport } from '../src/backend/mcp-stdio-supervisor.ts';

test('real stdio authoring passes pinned identity through the host and survives an A-B-A launch swap', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-authoring-stdio-')));
  const scope = join(root, 'scope'); mkdirSync(scope);
  const directory = workflowAuthoringDirectory(scope);
  const script = join(root, 'server.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const stat = fs.statSync('.', {bigint:true});
const identity = stat.dev + ':' + stat.ino;
setInterval(()=>{},1000);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  fs.appendFileSync('methods', msg.method + '\\n');
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize' ? {protocolVersion:msg.params.protocolVersion,
    capabilities:{tools:{}},serverInfo:{name:'scope-fixture',version:'1'}}
    : msg.method === 'tools/list' ? {tools:[{name:'identify',inputSchema:{type:'object',description:identity}}]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});
`);
  const config = new ConfigStore(join(root, 'state'));
  config.update({ projects: { root: scope }, filesystemIsolation: false, mcp: [{ id: 'local', name: 'Local', transport: 'stdio', command: process.execPath, args: [script], enabledByDefault: true }] });
  const host = new SessionHost({ mcpConnections: config.mcpConnections });
  const authoring = new WorkflowMcpAuthoringService({ host, config, scope: root });
  const start = SupervisedStdioTransport.prototype.start;
  t.mock.method(SupervisedStdioTransport.prototype, 'start', async function (this: SupervisedStdioTransport) {
    renameSync(scope, scope + '-original'); mkdirSync(scope);
    try { await start.call(this); }
    finally { renameSync(scope, scope + '-replacement'); renameSync(scope + '-original', scope); }
  });
  try {
    const catalogue = await authoring.catalogue(undefined, { scope, scopeIdentity: directory.identity });
    assert.equal(catalogue.errors.length, 0);
    assert.equal(catalogue.scopeIdentity, directory.identity);
    const inputSchema = catalogue.tools[0]!.inputSchema;
    assert.ok(typeof inputSchema === 'object' && inputSchema !== null);
    assert.equal(inputSchema.description, directory.identity);
    assert.ok(readFileSync(join(scope, 'methods'), 'utf8').includes('tools/list'));
    assert.equal(readFileSync(join(scope, 'methods'), 'utf8').includes('tools/call'), false);
    assert.equal(existsSync(join(scope + '-replacement', 'methods')), false);
    assert.deepEqual(host.list(), []);
  } finally { await authoring.shutdown(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const darwinChecks of [false, true]) test(`real HTTP MCP authoring initializes and lists tools using private headers without an Agent Session or tools/call${darwinChecks ? ' through bounded Darwin Scope checks' : ''}`, { timeout: 20_000 }, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
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
  if (darwinChecks) Object.defineProperty(process, 'platform', { value: 'darwin' });
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
    Object.defineProperty(process, 'platform', platform);
    await new Promise<void>((done, reject) => { http.close(error => error ? reject(error) : done()); http.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
