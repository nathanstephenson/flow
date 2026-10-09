import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerBackend } from '../src/backend/worker/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { WorkflowBuilderService } from '../src/daemon/workflow-builder.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import { isolationIntegration, privateWorkerState } from './isolation-fixture.ts';
import { piFixture, until } from './backend/pi-fixture.ts';

for (const projectSpecific of [false, true]) it(`isolated ${projectSpecific ? 'Project-specific' : 'machine-wide'} builder applies compact MCP drafts and reopens`, { ...isolationIntegration, timeout: 30000 }, async t => {
  const { root, scope } = privateWorkerState(t);
  const stateRoot = join(root, 'state');
  mkdirSync(stateRoot);
  const tool = { connectionId: 'configured', connectionName: 'Configured', identity: 'a'.repeat(64), serverIdentity: 'b'.repeat(64), toolName: 'lookup', inputSchema: { type: 'object', properties: {} } };
  const { connectionId, identity, serverIdentity, toolName } = tool;
  const definition: WorkflowDefinition = { version: 1, id: 'draft', name: 'Draft', backend: 'pi', ...(projectSpecific ? { projectId: scope } : {}), inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'one', name: 'One', kind: 'join' }], edges: [] };
  const content = JSON.stringify({ ...definition, projectId: projectSpecific ? scope : null, steps: [{ id: 'lookup', name: 'Lookup', kind: 'mcp', tool: { connectionId, identity, serverIdentity, toolName } }] });
  let requests = 0;
  const f = await piFixture(t, () => {
    switch (++requests % 3) {
      case 1: return { tools: [{ id: `read-${requests}`, name: 'workflow_builder_read', arguments: { path: 'mcp-tools.json' } }] };
      case 2: return { tools: [{ id: `write-${requests}`, name: 'workflow_builder_write', arguments: { content } }] };
      default: return { text: 'Draft updated' };
    }
  });
  writeFileSync(join(root, 'AGENTS.md'), 'AMBIENT AUTHORITY');
  symlinkSync(join(root, 'AGENTS.md'), join(f.scope, 'AGENTS.md'));
  symlinkSync(scope, join(f.scope, 'skills'));
  const credentials = readFileSync(join(f.scope, 'models.json'), 'utf8');
  const host = new SessionHost();
  host.registerBackend(new WorkerBackend({ backend: 'pi', isolationEnabled: () => true, stateRoot,
    env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: '1' } }));
  t.after(() => host.shutdown());
  const service = new WorkflowBuilderService({ host, stateRoot, scope,
    config: { projectRoot: () => scope, projectInclude: () => [scope], defaultModel: () => 'flow-test/parent', defaultEffort: () => 'off' },
    mcpCatalogue: async (scope, _projectId, scopeIdentity) => ({ scope, scopeIdentity, connections: [], tools: [tool], errors: [] }),
  });
  t.after(() => service.shutdown());
  const view = await service.create({ definition });
  assert.equal(view.scope, scope);
  for (const message of ['Build draft', 'Continue draft']) {
    service.message(view.id, message);
    await until(() => service.view(view.id).status !== 'running', 10000);
    const current = service.view(view.id);
    assert.equal(current.status, 'idle');
    assert.deepEqual(current.definition, { ...definition, steps: [{ id: 'lookup', name: 'Lookup', kind: 'mcp', tool }] });
    await service.abort(view.id);
  }
  assert.equal(requests, 6);
  assert.equal(readFileSync(join(f.scope, 'models.json'), 'utf8'), credentials);
  for (const request of f.requests) assert.ok(!JSON.stringify(request.messages).includes('AMBIENT AUTHORITY'));
});
