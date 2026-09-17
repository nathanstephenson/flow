import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { McpSession } from '../src/backend/mcp.ts';
import { McpAuth } from '../src/daemon/mcp-auth.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { connectionIdentity, sameSchema } from '../src/daemon/workflow-mcp.ts';
import { validateDefinition, resolveMapping } from '../src/workflows/graph.ts';
import { compileJsonSchema, validateJsonSchema } from '../src/workflows/json-schema.ts';
import { boundedMcpValue, validateMcpOutput } from '../src/workflows/mcp.ts';
import { parseExecution } from '../src/workflows/records.ts';
import type { Json, JsonSchema, McpToolSnapshot, WorkflowDefinition, WorkflowExecution } from '../src/protocol/workflows.ts';
import type { McpConnection } from '../src/protocol/mcp.ts';
import { reduceAll } from '../src/client/reduce.ts';

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 400; i++) { if (check()) return; await pause(); } assert.fail('Timed out'); }
const secret = 'oauth-credential-not-for-history';
const inputSchema: JsonSchema = { type: 'object', properties: { id: { type: 'string', minLength: 1 }, mode: { type: 'string' } }, required: ['id'], additionalProperties: false };
async function fixture(transport: 'stdio' | 'http' = 'http') {
  const root = mkdtempSync(join(tmpdir(), 'flow-workflow-mcp-'));
  const requests: Array<{ name: string; arguments: Record<string, Json>; authorization?: string }> = [];
  let schema = inputSchema;
  let lists = 0;
  let unsupported = false;
  let version = '1';
  let authenticated = true;
  let result: Json = { structuredContent: { id: 'LIN-123', exists: true }, content: [{ type: 'text', text: '{"not":"parsed"}' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }, { type: 'resource_link', uri: 'https://example.test/not-downloaded', name: 'resource' }] };
  const server = createServer(async (request, response) => {
    if (!authenticated || request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!Object.hasOwn(body, 'id')) { response.writeHead(202).end(); return; }
    let value: unknown = {};
    if (body.method === 'initialize') value = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'workflow-fixture', version } };
    else if (body.method === 'tools/list') {
      lists++;
      value = { tools: [{ name: 'Linear / issue.fetch', inputSchema: schema }, ...(unsupported ? [{ name: 'unrelated', inputSchema: { type: 'object', unsupportedKeyword: true } }] : [])] };
    }
    else if (body.method === 'tools/call') {
      requests.push({ ...body.params, authorization: request.headers.authorization });
      if (body.params.arguments.mode === 'delay') await pause(250);
      if (body.params.arguments.mode === 'long') await pause(10_100);
      value = result;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const connection: McpConnection = transport === 'http' ? { id: 'linear', name: 'Linear fixture', enabledByDefault: true, transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, oauth: true, headers: {} } : { id: 'local', name: 'Local fixture', enabledByDefault: true, transport: 'stdio', command: process.execPath, args: ['--experimental-strip-types', resolve('test/fixtures/mcp-server.ts')] };
  const auth = new McpAuth(root);
  await auth.provider(connection).saveTokens({ access_token: secret, refresh_token: 'refresh-secret', token_type: 'Bearer' });
  const store = new TranscriptStore(root), workflows = new WorkflowStore(root), secrets = new SecretStore(root), config = new ConfigStore(root);
  // Deliberately unavailable code runtime: MCP must not depend on it.
  config.update({ mcp: [connection], workflowRuntime: { externalSandbox: false, nodePath: '/does-not-exist' } });
  const backend = new FakeBackend();
  const host = new SessionHost({ store, retention: 0, mcpConnections: () => config.view().mcp ?? [], mcpAuth: auth });
  host.registerBackend(backend);
  const service = new WorkflowExecutionService(host, workflows, secrets, config, '/missing-runtime');
  await host.load();
  const id = await host.create({ backend: 'fake', scope: root });
  const discovered = await service.discoverMcp(id, connection.id);
  const tool = discovered.tools.find(tool => transport === 'http' || tool.toolName === 'echo')!;
  const definition: WorkflowDefinition = { version: 1, id: 'mcp', name: 'MCP', backend: 'fake', inputSchema: { type: 'object', fields: { id: { schema: { type: 'string' }, required: true } } }, steps: [{ id: 'fetch', name: 'Fetch', kind: 'mcp', tool, mapping: { kind: 'template', template: { kind: 'object', fields: { [transport === 'http' ? 'id' : 'text']: { kind: 'reference', reference: { source: 'input', path: ['id'] } } } } } }], edges: [] };
  return { listCount: () => lists, advertiseUnsupported: () => { unsupported = true; }, root, requests, connection, auth, workflows, config, backend, host, service, id, tool, definition,
    result(value: Json) { result = value; }, schema(value: JsonSchema) { schema = value; }, version(value: string) { version = value; }, authenticated(value: boolean) { authenticated = value; },
    async run(def = definition, input: Json = { id: 'LIN-123' }, stepId?: string) { const view = await service.start({ sessionId: id, definition: def, input, ...(stepId ? { stepId } : {}) }); return service.scheduler.wait(id, view.execution.id); },
    async close() { await host.shutdown(); auth.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
  };
}

test('direct HTTP/OAuth call uses original tool name, stable blocks, references, and no Agent or spend', async () => {
  const f = await fixture();
  try {
    const record = await f.run();
    assert.equal(record.status, 'completed');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.name, 'Linear / issue.fetch');
    assert.deepEqual(f.requests[0]!.arguments, { id: 'LIN-123' });
    assert.equal(f.backend.latest.workflowSubagents.length, 0);
    assert.equal(f.service.view(f.id, record.id).spend, undefined);
    assert.deepEqual((record.result as { content: Json[] }).content[0], { type: 'text', text: '{"not":"parsed"}' });
    assert.equal((record.result as { content: Json[] }).content.length, 3);
    assert.equal(f.workflows.getExecution(f.id, record.id).definition.steps[0]!.kind, 'mcp');
    assert.ok(!JSON.stringify(record).includes(secret));
  } finally { await f.close(); }
});

test('stdio discovery and text-only output work without parsing JSON text', async () => {
  const f = await fixture('stdio');
  try {
    const record = await f.run(f.definition, { id: '{"a":1}' });
    assert.deepEqual(record.result, { structuredContent: null, content: [{ type: 'text', text: '{"a":1}' }] });
    assert.equal(f.backend.latest.workflowSubagents.length, 0);
  } finally { await f.close(); }
});

test('MCP structured fields feed an Agent directly; empty/not-found data drives a Branch', async () => {
  const f = await fixture();
  try {
    const def: WorkflowDefinition = { ...f.definition, steps: [...f.definition.steps, { id: 'agent', name: 'Grill', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'Grill issue', outputSchema: { type: 'string' }, mapping: { kind: 'reference', reference: { source: 'step', stepId: 'fetch', path: ['structuredContent'] } } }], edges: [{ id: 'next', from: 'fetch', to: 'agent', outcome: 'success' }] };
    const started = await f.service.start({ sessionId: f.id, definition: def, input: { id: 'LIN-123' } });
    await until(() => f.backend.latest.workflowSubagents.length === 1);
    assert.deepEqual(f.backend.latest.workflowSubagents[0]!.options.input, { id: 'LIN-123', exists: true });
    f.backend.latest.workflowSubagents[0]!.complete('grilled');
    assert.equal((await f.service.scheduler.wait(f.id, started.execution.id)).result, 'grilled');
    f.result({ structuredContent: { exists: false }, content: [] });
    const branch: WorkflowDefinition = { ...f.definition, steps: [...f.definition.steps, { id: 'branch', name: 'Exists', kind: 'branch', condition: { operator: 'truthy', path: ['structuredContent', 'exists'] } }], edges: [{ id: 'check', from: 'fetch', to: 'branch', outcome: 'success' }] };
    const record = await f.run(branch);
    assert.equal(record.status, 'completed');
    assert.equal(record.steps.branch!.outcome, 'false');
  } finally { await f.close(); }
});

for (const single of [false, true]) test(`ask permission is private and required for ${single ? 'single-step tests' : 'normal execution'}; denial never calls`, async () => {
  const f = await fixture();
  try {
    const def = { ...f.definition, permission: 'ask' as const };
    const started = await f.service.start({ sessionId: f.id, definition: def, input: { id: 'LIN-123' }, ...(single ? { stepId: 'fetch' } : {}) });
    await until(() => f.service.view(f.id, started.execution.id).permissions.length === 1);
    const prompt = f.service.view(f.id, started.execution.id).permissions[0]!;
    assert.equal(prompt.direct, true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.backend.latest.workflowSubagents.length, 0);
    await until(() => f.backend.latest.prompts.some(text => text.includes('workflow_relay_permission')));
    const firstRequestId = /requestId "([0-9a-f-]+)"/.exec(f.backend.latest.prompts.find(text => text.includes('workflow_relay_permission'))!)?.[1];
    assert.ok(firstRequestId);
    const firstRelay = f.backend.latest.workflow!.relayPermission({ requestId: firstRequestId });
    const authorising = () => reduceAll(f.host.logFor(f.id).since(0)).authorising;
    await until(() => authorising()?.tool === f.tool.toolName);
    assert.equal(authorising()!.allowAlways, false);
    assert.match(authorising()!.authorizationScope ?? '', /Standing authorization is unavailable/);
    await assert.rejects(f.host.answerPermission(f.id, authorising()!.callId, 'always'), /only be allowed once or denied/);
    await f.host.answerPermission(f.id, authorising()!.callId, 'deny');
    await firstRelay;
    f.backend.latest.completeTurn();
    const failed = await f.service.scheduler.wait(f.id, started.execution.id);
    assert.equal(failed.status, 'recovery-required');
    if (!single) {
      await until(() => f.backend.latest.prompts.some(text => text.includes('workflow_recover')));
      f.backend.latest.completeTurn();
    }
    await f.service.recover(f.id, started.execution.id, { kind: 'retry', stepId: 'fetch' });
    await until(() => f.service.view(f.id, started.execution.id).permissions.length === 1);
    const again = f.service.view(f.id, started.execution.id).permissions[0]!;
    assert.notEqual(again.callId, prompt.callId);
    await until(() => f.backend.latest.prompts.filter(text => text.includes('workflow_relay_permission')).length === 2);
    const secondPrompt = f.backend.latest.prompts.filter(text => text.includes('workflow_relay_permission'))[1]!;
    const secondRequestId = /requestId "([0-9a-f-]+)"/.exec(secondPrompt)?.[1];
    assert.ok(secondRequestId);
    const secondRelay = f.backend.latest.workflow!.relayPermission({ requestId: secondRequestId });
    await until(() => authorising()?.callId !== undefined);
    await f.host.answerPermission(f.id, authorising()!.callId, 'allow');
    await secondRelay;
    assert.equal((await f.service.scheduler.wait(f.id, started.execution.id)).status, 'completed-with-recovery');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('MCP errors retain redacted bounded partial output and can be supplied without replay', async () => {
  const f = await fixture();
  try {
    f.result({ isError: true, structuredContent: { reason: secret }, content: [{ type: 'text', text: `failure ${secret}` }] });
    const failed = await f.run();
    assert.equal(failed.status, 'recovery-required');
    assert.ok(failed.steps.fetch!.attempts[0]!.partialOutput);
    assert.ok(!JSON.stringify(failed).includes(secret));
    const disk = readFileSync(join(f.root, 'sessions', f.id, 'workflows', failed.id + '.json'), 'utf8');
    assert.ok(!disk.includes(secret));
    await f.service.recover(f.id, failed.id, { kind: 'supply', stepId: 'fetch', output: { structuredContent: null, content: [] } });
    assert.equal((await f.service.scheduler.wait(f.id, failed.id)).status, 'completed-with-recovery');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

for (const drift of ['schema', 'server', 'config', 'disabled', 'auth'] as const) test(`revalidation detects ${drift} drift without automatic calls or retargeting`, async () => {
  const f = await fixture();
  try {
    f.result({ isError: true, content: [] });
    const failed = await f.run();
    if (drift === 'schema') f.schema({ ...inputSchema as object, required: ['id', 'mode'] });
    if (drift === 'server') f.version('2');
    if (drift === 'config') { assert.equal(f.connection.transport, 'http'); f.config.update({ mcp: [{ ...f.connection, url: (f.connection as { url: string }).url + '/changed' }] }); }
    if (drift === 'disabled') f.config.update({ mcp: [] });
    if (drift === 'auth') f.authenticated(false);
    try {
      await f.service.recover(f.id, failed.id, { kind: 'retry', stepId: 'fetch' });
      assert.equal((await f.service.scheduler.wait(f.id, failed.id)).status, 'recovery-required');
    } catch (error) { assert.match(String(error), /MCP/); }
    assert.equal(f.requests.length, 1);
    await assert.rejects(f.service.start({ sessionId: f.id, definition: f.definition, input: { id: 'other' } }));
  } finally { await f.close(); }
});

test('timeout and cancellation stop owned work, never replay, and leave unrelated MCP clients usable', async () => {
  const f = await fixture();
  const parent = new McpSession([f.connection], f.root, connection => f.auth.provider(connection), true);
  try {
    await parent.open();
    const def: WorkflowDefinition = { ...f.definition, steps: [{ ...f.definition.steps[0]!, timeoutMs: 80, mapping: { kind: 'template', template: { kind: 'literal', value: { id: 'write', mode: 'delay' } } } }] };
    const timedOut = await f.run(def);
    assert.equal(timedOut.steps.fetch!.status, 'timed-out');
    await pause(300);
    assert.equal(f.requests.length, 1);
    assert.ok(await parent.tools()[0]!.call({ id: 'parent' }));
    await f.service.cancel(f.id, timedOut.id);
    const started = await f.service.start({ sessionId: f.id, definition: { ...def, steps: [{ ...def.steps[0]!, timeoutMs: 2000 }] }, input: { id: 'id' } });
    await until(() => f.requests.length === 3);
    await f.service.cancel(f.id, started.execution.id);
    assert.equal(f.service.view(f.id, started.execution.id).execution.status, 'cancelled');
    assert.ok(await parent.tools()[0]!.call({ id: 'still-usable' }));
  } finally { await parent.dispose(); await f.close(); }
});

test('configured HTTP call timeout can exceed the old 10 second fetch limit', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const def: WorkflowDefinition = { ...f.definition, steps: [{ ...f.definition.steps[0]!, timeoutMs: 12_000, mapping: { kind: 'template', template: { kind: 'literal', value: { id: 'slow', mode: 'long' } } } }] };
    assert.equal((await f.run(def)).status, 'completed');
  } finally { await f.close(); }
});

test('large multibyte output is retained without truncation; invalid arguments do not call', async () => {
  const f = await fixture();
  try {
    f.result({ content: [{ type: 'text', text: 'é'.repeat(50_000) }] });
    const failed = await f.run();
    assert.equal(failed.status, 'completed');
    assert.deepEqual(failed.steps.fetch!.output, { structuredContent: null, content: [{ type: 'text', text: 'é'.repeat(50_000) }] });
    await f.service.cancel(f.id, failed.id);
    const invalid: WorkflowDefinition = { ...f.definition, steps: [{ ...f.definition.steps[0]!, mapping: { kind: 'template', template: { kind: 'literal', value: { id: '' } } } }] };
    const bad = await f.run(invalid);
    assert.equal(bad.steps.fetch!.status, 'failed');
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('credentials are refused in saved arguments, input and supplied output and redacted from success', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.validateDefinitionCredentials({ ...f.definition, name: secret }), /secret/);
    await assert.rejects(f.service.start({ sessionId: f.id, definition: f.definition, input: { id: secret } }), /secret/);
    f.result({ content: [{ type: 'text', text: secret }], structuredContent: { [secret]: secret } });
    const record = await f.run();
    assert.ok(!JSON.stringify(record).includes(secret));
    assert.ok(JSON.stringify(record.result).includes('[REDACTED]'));
    f.result({ isError: true, content: [] });
    const failed = await f.run();
    await assert.rejects(f.service.recover(f.id, failed.id, { kind: 'supply', stepId: 'fetch', output: { structuredContent: secret, content: [] } }), /secret/);
  } finally { await f.close(); }
});

const snapshot: McpToolSnapshot = { connectionId: 'c', connectionName: 'C', identity: '0'.repeat(64), serverIdentity: '1'.repeat(64), toolName: 't', inputSchema: true };
test('full JSON Schema dialects validate original constraints, reject unknown validation, and keep null/JSON', () => {
  const schema: JsonSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', $defs: { id: { type: ['string', 'null'], pattern: '^LIN-' } }, properties: { id: { $ref: '#/$defs/id' }, count: { type: 'integer', minimum: 1 }, tuple: { type: 'array', prefixItems: [{ const: 'a' }, { type: 'boolean' }], items: false, minItems: 2 } }, required: ['id'], dependentRequired: { count: ['tuple'] }, if: { properties: { id: { type: 'null' } } }, then: { not: { required: ['count'] } }, unevaluatedProperties: false };
  validateJsonSchema(schema, { id: 'LIN-1', count: 1, tuple: ['a', true] });
  validateJsonSchema(schema, { id: null });
  for (const value of [{ id: 'bad' }, { id: 'LIN-1', count: 0 }, { id: null, count: 1 }, { id: 'LIN-1', extra: true }, { id: 'LIN-1', tuple: ['a', true, 'extra'] }]) assert.throws(() => validateJsonSchema(schema, value), /schema validation/);
  validateJsonSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'array', items: [{ const: 1 }], additionalItems: false }, [1]);
  validateJsonSchema({ $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'array', contains: { const: 1 }, minContains: 1, maxContains: 1 }, [1, 2]);
  assert.throws(() => compileJsonSchema({ customValidation: true }), /No validation was skipped/);
  assert.throws(() => compileJsonSchema({ $ref: 'https://not-fetched.test/schema' }), /No validation was skipped/);
  assert.deepEqual(validateMcpOutput(snapshot, { structuredContent: null, content: [] }), { structuredContent: null, content: [] });
  assert.throws(() => validateMcpOutput({ ...snapshot, outputSchema: { type: 'object', required: ['id'] } }, { structuredContent: null, content: [] }));
  assert.equal(boundedMcpValue('💡'.repeat(25_000)), '💡'.repeat(25_000));
});

test('MCP envelope validation preserves JSON content and rejects non-JSON extras', () => {
  const output = { structuredContent: { ok: true }, content: [{ type: 'resource', resource: { uri: 'test://item', text: 'body' }, annotations: { audience: ['user'] } }] };
  assert.deepEqual(validateMcpOutput(snapshot, output), output);
  for (const invalid of [
    { ...output, extra: true },
    { ...output, content: [{ type: 'text', text: undefined }] },
    { ...output, content: [{ type: 'text', extra: NaN }] },
    { ...output, content: [{}] },
    { ...output, structuredContent: undefined },
  ]) assert.throws(() => validateMcpOutput(snapshot, invalid));
  assert.doesNotThrow(() => validateMcpOutput(snapshot, { structuredContent: null, content: [{ type: 'text', text: '💡'.repeat(25_000) }] }));
});

test('post-redaction expansion retains the complete JSON result', () => {
  const raw = boundedMcpValue({ structuredContent: null, content: [{ type: 'text', text: 'key '.repeat(12_000) }] });
  const redacted = JSON.parse(JSON.stringify(raw).replaceAll('key', '[REDACTED]'));
  assert.deepEqual(boundedMcpValue(redacted), redacted);
});

test('templates preserve literals and nested references, reject unavailable predecessors, and round-trip records', async () => {
  const f = await fixture();
  try {
    const graph = validateDefinition(f.definition);
    const record = await f.run();
    assert.deepEqual(parseExecution(record), record);
    assert.deepEqual(resolveMapping(record, { ...graph.order[0]!, mapping: { kind: 'template', template: { kind: 'object', fields: { literal: { kind: 'literal', value: null }, array: { kind: 'array', items: [{ kind: 'reference', reference: { source: 'input', path: ['id'] } }] } } } } }), { literal: null, array: ['LIN-123'] });
    const invalid = structuredClone(f.definition);
    invalid.steps[0]!.mapping = { kind: 'template', template: { kind: 'reference', reference: { source: 'step', stepId: 'missing', path: [] } } };
    assert.throws(() => validateDefinition(invalid), /earlier step/);
    const corrupted = structuredClone(record);
    corrupted.steps.fetch!.output = { structuredContent: null, content: [{ type: 'text', text: 'x'.repeat(100_000) }] };
    assert.deepEqual(parseExecution(corrupted), corrupted);
    assert.notEqual(connectionIdentity(f.connection), connectionIdentity({ ...f.connection, id: 'another' }));
    // Headers only join the hash once there are some, so identities recorded before headers existed
    // keep matching; a header change is a reconfiguration and must not.
    const http = { ...f.connection, transport: 'http' as const, url: 'https://example.test/mcp', oauth: false, headers: {} };
    assert.equal(connectionIdentity(http), createHash('sha256').update(JSON.stringify([http.id, 'http', http.url, false])).digest('hex'));
    assert.notEqual(connectionIdentity(http), connectionIdentity({ ...http, headers: { Authorization: { secret: 'token' } } }));
  } finally { await f.close(); }
});

test('MCP failure and timeout edges join into recovery without automatic retry', async () => {
  const f = await fixture();
  try {
    f.result({ isError: true, content: [{ type: 'text', text: 'not found is only failure when isError is set' }] });
    const definition: WorkflowDefinition = { ...f.definition, steps: [...f.definition.steps, { id: 'handle', name: 'Handle failure', kind: 'join' }], edges: [{ id: 'failure', from: 'fetch', to: 'handle', outcome: 'failure' }] };
    const result = await f.run(definition);
    assert.equal(result.status, 'completed-with-recovery');
    assert.equal(result.steps.handle!.status, 'completed');
    assert.ok(JSON.stringify(result.steps.handle!.output).includes('partialOutput'));
    assert.equal(f.requests.length, 1);
    const timeout: WorkflowDefinition = { ...definition, steps: [{ ...f.definition.steps[0]!, timeoutMs: 80, mapping: { kind: 'template', template: { kind: 'literal', value: { id: 'write', mode: 'delay' } } } }, definition.steps[1]!], edges: [{ id: 'timeout', from: 'fetch', to: 'handle', outcome: 'timeout' }] };
    assert.equal((await f.run(timeout)).status, 'completed-with-recovery');
  } finally { await f.close(); }
});

test('MCP loop repeats only on graph selection and waits for explicit extra-try recovery', async () => {
  const f = await fixture();
  try {
    const fetch = { ...f.definition.steps[0]!, repeatMapping: f.definition.steps[0]!.mapping! };
    const definition: WorkflowDefinition = { ...f.definition, loopSettings: { fetch: { maxTries: 1 } }, steps: [{ id: 'root', name: 'Root', kind: 'join' }, fetch, { id: 'check', name: 'Check', kind: 'branch', condition: { operator: 'truthy', path: ['structuredContent', 'exists'] } }, { id: 'end', name: 'End', kind: 'join' }], edges: [{ id: 'entry', from: 'root', to: 'fetch', outcome: 'success' }, { id: 'check', from: 'fetch', to: 'check', outcome: 'success' }, { id: 'back', from: 'check', to: 'fetch', outcome: 'true' }, { id: 'exit', from: 'check', to: 'end', outcome: 'false' }] };
    const limit = await f.run(definition);
    assert.equal(limit.status, 'recovery-required');
    assert.equal(f.requests.length, 1);
    assert.equal(limit.loops!.fetch!.phase, 'limit');
    f.result({ structuredContent: { exists: false }, content: [] });
    await f.service.recover(f.id, limit.id, { kind: 'extend-loop', headerId: 'fetch', activation: 1, try: 1 });
    const result = await f.service.scheduler.wait(f.id, limit.id);
    assert.equal(result.status, 'completed-with-recovery');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(parseExecution(result), result);
  } finally { await f.close(); }
});


test('preflight discovers once per connection and ignores unrelated unsupported schemas', async () => {
  const f = await fixture();
  try {
    f.advertiseUnsupported();
    const step = f.definition.steps[0]!;
    const definition = { ...f.definition, steps: [step, { ...step, id: 'second', name: 'Second' }], edges: [{ id: 'next', from: step.id, to: 'second', outcome: 'success' as const }] };
    // Opening the Agent Session discovers its own tools independently of preflight.
    await f.host.openWorkflowSession(f.id);
    await until(() => f.host.mcpStatus(f.id)[0]?.state === 'connected');
    const before = f.listCount();
    const record = await f.run(definition);
    assert.equal(record.status, 'completed');
    assert.equal(f.listCount() - before, 3); // One preflight, two execution-time checks.
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('schema equality ignores object key order but preserves array order and missing values', () => {
  assert.ok(sameSchema({ type: 'object', properties: { a: true, b: false } }, { properties: { b: false, a: true }, type: 'object' }));
  assert.ok(!sameSchema({ enum: [1, 2] }, { enum: [2, 1] }));
  assert.ok(!sameSchema(undefined, {}));
});
