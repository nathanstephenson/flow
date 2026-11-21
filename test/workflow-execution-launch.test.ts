import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { WorkflowEnvironment } from '../src/daemon/workflow-environment.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';
import { WorkflowStore } from '../src/workflows/store.ts';

async function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-launch-'));
  const config = new ConfigStore(root);
  config.update({ filesystemIsolation: 'none', workflowRuntime: { nodePath: process.execPath } });
  const backend = new FakeBackend();
  const host = new SessionHost({ store: new TranscriptStore(root), filesystemIsolationMode: () => 'none' });
  host.registerBackend(backend);
  const store = new WorkflowStore(root);
  const service = new WorkflowExecutionService(host, store, new SecretStore(root), config, '/unused');
  await host.load();
  t.after(async () => { await service.stopScheduled(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return { root, backend, host, service, store };
}

const definition: WorkflowDefinition = {
  version: 1, id: 'launch', name: 'Launch', backend: 'fake', inputSchema: { type: 'object', fields: {} },
  steps: [{ id: 'agent', name: 'Agent', kind: 'agent', model: 'fake-2', effort: 'high', instructions: 'JSON', outputSchema: { type: 'string' } }], edges: [],
};
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out');
}

test('manual and scheduled agents apply the same confirmed no-control effort policy', async t => {
  const f = await fixture(t);
  const manualId = await f.host.create({ scope: f.root, backend: 'fake' });
  const manual = await f.service.start({ sessionId: manualId, definition, input: {} });
  const scheduled = await f.service.startScheduled({ occurrenceId: 'scheduled', definition, input: {}, scope: f.root, projectId: f.root, mcpConnectionIds: [],
    attach: () => f.host.attachScheduled({ scope: f.root, backend: 'fake', scheduled: { id: 'scheduled-parent', occurrenceId: 'scheduled' } }),
  });
  await until(() => f.backend.sessions.filter(session => !session.toolless).length === 2 && f.backend.sessions.filter(session => !session.toolless).every(session => session.workflowSubagents.length === 1));
  const probes = f.backend.sessions.filter(session => session.toolless);
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0]!.workflowSubagents, []);
  assert.deepEqual(probes[0]!.prompts, []);
  for (const session of f.backend.sessions.filter(session => !session.toolless)) {
    const agent = session.workflowSubagents[0]!;
    assert.equal(agent.options.effort, 'off');
    agent.complete('"done"');
  }
  assert.equal((await f.service.scheduler.wait(manualId, manual.execution.id)).status, 'completed');
  assert.equal((await f.service.scheduler.wait('occurrence-scheduled', scheduled.execution.id)).status, 'completed');
});

test('terminal environment cleanup still runs when occurrence publication fails', async t => {
  const f = await fixture(t);
  let closed = 0;
  const close = WorkflowEnvironment.prototype.close;
  t.mock.method(WorkflowEnvironment.prototype, 'close', function (this: WorkflowEnvironment) { closed++; return close.call(this); });
  f.service.onScheduledResult = async () => { throw new Error('Occurrence summary unavailable'); };
  const graph: WorkflowDefinition = { ...definition, steps: [{ id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } }] };
  const view = await f.service.startScheduled({ occurrenceId: 'publication', definition: graph, input: {}, scope: f.root, projectId: f.root, mcpConnectionIds: [], attach: () => { throw new Error('Must not attach'); } });
  assert.equal((await f.service.scheduler.wait('occurrence-publication', view.execution.id)).status, 'completed');
  await until(() => closed > 0);
  assert.equal(f.host.list().length, 0);
});

test('retention waits for terminal publication before forgetting its execution resources', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const publishing = new Promise<void>(resolve => { release = resolve; });
  let started = false, expired = false;
  f.service.onScheduledResult = async () => { started = true; await publishing; };
  const graph: WorkflowDefinition = { ...definition, steps: [{ id: 'done', name: 'Done', kind: 'join' }] };
  const view = await f.service.startScheduled({ occurrenceId: 'retention', definition: graph, input: {}, scope: f.root, projectId: f.root, mcpConnectionIds: [], attach: () => { throw new Error('Must not attach'); } });
  await f.service.scheduler.wait('occurrence-retention', view.execution.id);
  await until(() => started);
  const expiring = f.service.expireScheduled('retention').then(() => { expired = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(expired, false);
  } finally { release(); }
  await expiring;
  assert.equal(expired, true);
});

test('cancelled scheduled preparation creates neither checkpoint nor Agent Session', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await assert.rejects(f.service.startScheduled({ occurrenceId: 'cancelled', definition, input: {}, scope: f.root, projectId: f.root, mcpConnectionIds: [], signal: controller.signal,
    attach: () => { throw new Error('Must not attach'); },
  }), /Cancelled/);
  assert.equal(f.host.list().length, 0);
  assert.deepEqual(f.store.listExecutions('occurrence-cancelled'), []);
});
