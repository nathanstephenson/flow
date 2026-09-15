import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHost } from '../src/daemon/host.ts';
import { serve } from '../src/daemon/server.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { workflowRuntimeOptions } from '../src/workflows/runtime-settings.ts';

it('serves private machine-wide workflow and secret CRUD through authenticated HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-workflow-api-'));
  const secrets = new SecretStore(root);
  const workflows = new WorkflowStore(root);
  const config = new ConfigStore(root);
  const running = await serve({ host: new SessionHost(), token: 'test-token', assets: {}, secrets, workflows, config });
  const request = (path: string, method = 'GET', body?: unknown, headers = {}) => fetch(running.url + path, {
    method, headers: { authorization: 'Bearer test-token', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  try {
    for (const path of ['/api/workflows', '/api/secrets']) {
      assert.equal((await fetch(running.url + path)).status, 401);
      assert.equal((await request(path, 'GET', undefined, { origin: 'http://evil.test' })).status, 403);
    }
    assert.equal((await request('/api/secrets/key', 'PUT', { value: 'private-value' })).status, 200);
    assert.deepEqual(await (await request('/api/secrets')).json(), { names: ['key'] });
    assert.deepEqual(await (await request('/api/secrets/key')).json(), { name: 'key' });
    assert.equal(statSync(join(root, 'secrets')).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 'secrets/key.secret')).mode & 0o777, 0o600);
    assert.equal(new SecretStore(root).resolve('key'), 'private-value');
    await request('/api/secrets/key', 'PUT', { value: 'replacement' });
    assert.equal(secrets.resolve('key'), 'replacement');
    for (const name of ['constructor', '__proto__', 'bad%2Fname', '%ZZ']) assert.equal((await request('/api/secrets/' + name, 'PUT', { value: 'private-value' })).status, 400);
    for (const body of ['{private-value', { value: 4 }, { value: 'private-value', extra: true }]) {
      const response = await request('/api/secrets/key', 'PUT', body);
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes('private-value'));
    }
    assert.equal((await request('/api/secrets/key', 'PUT', 'x'.repeat(400_001))).status, 413);
    const definition = { version: 1, id: 'example', name: 'Example', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [{ id: 'join', name: 'Join', kind: 'join' }], edges: [] };
    assert.equal((await request('/api/workflows/example', 'PUT', definition)).status, 200);
    assert.equal(new WorkflowStore(root).getDefinition('example').name, 'Example');
    assert.equal((await (await request('/api/workflows')).json() as { workflows: unknown[] }).workflows.length, 1);
    assert.deepEqual(await (await request('/api/workflows/example')).json(), { workflow: workflows.getDefinition('example') });
    for (const body of ['{', { ...definition, id: 'other' }, { ...definition, edges: [{ id: 'bad', from: 'absent', to: 'join', outcome: 'success' }] }, { ...definition, steps: [{ ...definition.steps[0], secrets: { token: '../bad' } }] }]) assert.equal((await request('/api/workflows/example', 'PUT', body)).status, 400);
    assert.equal((await request('/api/workflows/bad%2Fid')).status, 400);
    assert.equal((await request('/api/workflows/example', 'PUT', 'x'.repeat(1_000_001))).status, 413);
    const history = join(root, 'sessions/session/workflows');
    mkdirSync(history, { recursive: true });
    writeFileSync(join(history, 'snapshot.json'), JSON.stringify({ definition }));
    await request('/api/workflows/example', 'DELETE');
    assert.equal((await request('/api/workflows/example')).status, 404);
    assert.deepEqual(JSON.parse(readFileSync(join(history, 'snapshot.json'), 'utf8')), { definition });
    const initial = await (await request('/api/config')).json() as { workflowRuntime: unknown };
    assert.deepEqual(initial.workflowRuntime, { externalSandbox: true, dockerImage: 'flow-workflow-runtime:local' });
    assert.equal((await request('/api/config', 'PUT', { workflowRuntime: { externalSandbox: false, nodePath: '/opt/node' } })).status, 200);
    await request('/api/config', 'PUT', { workflowRuntime: { dockerImage: 'node:22' } });
    assert.deepEqual(new ConfigStore(root).view().workflowRuntime, { externalSandbox: false, dockerImage: 'node:22', nodePath: '/opt/node' });
    assert.equal((await request('/api/config', 'PUT', { workflowRuntime: { externalSandbox: 'false' } })).status, 400);
    await request('/api/config', 'PUT', { workflowRuntime: { nodePath: '' } });
    assert.equal(config.view().workflowRuntime?.nodePath, undefined);
    assert.equal(workflowRuntimeOptions(undefined, '').nodePath, undefined);
    assert.equal(workflowRuntimeOptions({ externalSandbox: true, dockerImage: 'node:22', nodePath: '/override/node' }, '').nodePath, '/override/node');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ unknown: 3, workflowRuntime: { externalSandbox: 'invalid', dockerImage: 'node:22' } }));
    const reloaded = new ConfigStore(root);
    assert.equal(reloaded.view().workflowRuntime?.externalSandbox, true);
    assert.equal(reloaded.view().workflowRuntime?.dockerImage, 'node:22');
    assert.ok(reloaded.warning);
    reloaded.update({ workflowRuntime: { externalSandbox: false } });
    assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).unknown, 3);
    assert.ok(!readFileSync(join(root, 'config.json'), 'utf8').includes('replacement'));
    await request('/api/secrets/key', 'DELETE');
    assert.deepEqual(new SecretStore(root).list(), []);
    assert.equal((await request('/api/secrets/key')).status, 404);
  } finally { await running.close(); rmSync(root, { recursive: true, force: true }); }
});
