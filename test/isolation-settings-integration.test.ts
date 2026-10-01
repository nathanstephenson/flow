import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { serve } from '../src/daemon/server.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { FakeBackend } from '../src/backend/fake/index.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import type { Settings, FilesystemIsolationStatus } from '../src/protocol/settings.ts';
type SettingsResponse = Settings & { filesystemIsolationStatus: FilesystemIsolationStatus };

const assets = mkdtempSync(join(tmpdir(), 'flow-isolation-settings-runtime-'));
const runtimePath = join(assets, 'runtime.cjs');
before(() => execFileSync(process.execPath, ['scripts/build-workflow-runtime.mjs', runtimePath]));
after(() => rmSync(assets, { recursive: true, force: true }));

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'flow-isolation-settings-'));
  const scope = join(directory, 'scope'), stateRoot = join(directory, 'state');
  mkdirSync(scope); mkdirSync(stateRoot);
  const config = new ConfigStore(stateRoot, async () => ({ supported: false, reason: 'Test namespaces unavailable' }));
  await config.initializeFilesystemIsolation();
  config.update({ workflowRuntime: { nodePath: process.execPath } });
  const store = new TranscriptStore(stateRoot), workflows = new WorkflowStore(stateRoot), secrets = new SecretStore(stateRoot);
  const host = new SessionHost({ store, filesystemIsolationEnabled: config.filesystemIsolationEnabled });
  host.registerBackend(new FakeBackend());
  const service = new WorkflowExecutionService(host, workflows, secrets, config, runtimePath);
  const id = await host.create({ backend: 'fake', scope });
  return {
    directory, scope, stateRoot, config, host, service, id,
    restartService: () => new WorkflowExecutionService(host, workflows, secrets, config, runtimePath),
    async close() { await host.shutdown(); rmSync(directory, { recursive: true, force: true }); },
  };
}
function graph(command: string): WorkflowDefinition {
  return { version: 1, id: 'mode-test', name: 'Mode test', backend: 'fake', permission: 'auto-accept', inputSchema: { type: 'object', fields: {} },
    steps: [{ id: 'shell', name: 'Shell', kind: 'shell', command }], edges: [] };
}
function quote(path: string) { return `'${path.replaceAll("'", "'\\''")}'`; }
async function missingBoundary<T>(action: () => Promise<T>) {
  const previous = process.env.FLOW_BWRAP_PATH;
  process.env.FLOW_BWRAP_PATH = '/missing-flow-test-bwrap';
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.FLOW_BWRAP_PATH; else process.env.FLOW_BWRAP_PATH = previous; }
}

it('reports automatic unsupported mode and explicit fail-closed choice through authenticated Settings API', async () => {
  const f = await fixture();
  const server = await serve({ host: f.host, token: 'test', assets: {}, config: f.config, workflowExecutions: f.service });
  const request = (method: string, patch?: unknown) => fetch(server.url + '/api/config', {
    method, headers: { authorization: 'Bearer test' }, ...(patch ? { body: JSON.stringify(patch) } : {}),
  });
  try {
    assert.equal((await fetch(server.url + '/api/config', { method: 'PUT', body: JSON.stringify({ filesystemIsolation: false }) })).status, 401);
    assert.deepEqual((await (await request('GET')).json() as SettingsResponse).filesystemIsolationStatus,
      { supported: false, enabled: false, automatic: true, checking: false, reason: 'Test namespaces unavailable' });
    assert.equal(f.host.filesystemIsolationEnabled(), false);
    const manual = await (await request('PUT', { filesystemIsolation: true })).json() as SettingsResponse;
    assert.equal(manual.filesystemIsolation, true);
    assert.equal(manual.filesystemIsolationStatus.enabled, true);
    assert.equal(manual.filesystemIsolationStatus.automatic, false);
    assert.equal(f.host.filesystemIsolationEnabled(), true);
    await request('PUT', { retention: { settled: '2d' } });
    assert.equal(f.host.filesystemIsolationEnabled(), true);
    const reset = await (await request('PUT', { filesystemIsolation: null })).json() as SettingsResponse;
    assert.equal(Object.hasOwn(reset, 'filesystemIsolation'), false);
    assert.equal(reset.filesystemIsolationStatus.automatic, true);
    assert.equal(reset.filesystemIsolationStatus.enabled, false);
    assert.equal(new ConfigStore(f.stateRoot).view().filesystemIsolation, undefined);
    for (const value of ['false', 1, {}]) assert.equal((await request('PUT', { filesystemIsolation: value })).status, 400);
  } finally { await server.close(); await f.close(); }
});

it('snapshots active Workflow launch policy while enabling isolation refuses new work without a boundary', { skip: process.platform === 'win32' }, async () => {
  await missingBoundary(async () => {
    const f = await fixture();
    const outside = join(f.directory, 'outside-scope');
    try {
      const started = await f.service.start({ sessionId: f.id, definition: graph(`sleep 0.1; printf old-mode > ${quote(outside)}`), input: {} });
      f.config.update({ filesystemIsolation: true });
      f.service.refresh();
      const completed = await f.service.scheduler.wait(f.id, started.execution.id);
      assert.equal(completed.status, 'completed');
      assert.equal(readFileSync(outside, 'utf8'), 'old-mode');
      rmSync(outside);
      await assert.rejects(f.service.start({ sessionId: f.id, definition: graph(`printf forbidden > ${quote(outside)}`), input: {} }), /isolation unavailable|runtime.*unavailable|Bubblewrap|bwrap/i);
      assert.equal(existsSync(outside), false);
      assert.equal(f.service.list(f.id).occupied, false);
    } finally { await f.close(); }
  });
});

for (const legacy of [false, true]) {
  it(legacy ? 'keeps legacy Workflow recovery restricted even when the current default is unrestricted' : 'restores a Workflow recovery policy across a service restart rather than adopting changed Settings', { skip: process.platform === 'win32' }, async () => {
    await missingBoundary(async () => {
      const f = await fixture();
      const outside = join(f.directory, 'recovery-outside');
      try {
        const started = await f.service.start({ sessionId: f.id, definition: graph(`if test ! -e first-attempt; then touch first-attempt; exit 2; fi; printf retried > ${quote(outside)}`), input: {} });
        assert.equal((await f.service.scheduler.wait(f.id, started.execution.id)).status, 'recovery-required');
        const privatePath = join(f.stateRoot, 'sessions', f.id, 'workflow-activity', started.execution.id + '.json');
        const saved = JSON.parse(readFileSync(privatePath, 'utf8'));
        assert.equal(saved.runtime.isolationEnabled, false);
        if (legacy) { delete saved.runtime.isolationEnabled; writeFileSync(privatePath, JSON.stringify(saved)); }
        else f.config.update({ filesystemIsolation: true });
        const restored = f.restartService();
        restored.reconcile();
        if (legacy) {
          await assert.rejects(restored.recover(f.id, started.execution.id, { kind: 'retry', stepId: 'shell' }), /isolation unavailable|runtime.*unavailable|Bubblewrap|bwrap/i);
          assert.equal(existsSync(outside), false);
        } else {
          await restored.recover(f.id, started.execution.id, { kind: 'retry', stepId: 'shell' });
          assert.equal((await restored.scheduler.wait(f.id, started.execution.id)).status, 'completed-with-recovery');
          assert.equal(readFileSync(outside, 'utf8'), 'retried');
        }
      } finally { await f.close(); }
    });
  });
}
