import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { SecretStore } from '../src/daemon/secret-store.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { serve } from '../src/daemon/server.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { savedDefinitionRevision } from '../src/workflows/recovery.ts';
import { reduceAll } from '../src/client/reduce.ts';
import type { WorkflowDefinition } from '../src/protocol/workflows.ts';

const definition: WorkflowDefinition = {
  version: 1, id: 'saved-fix', name: 'Saved correction', backend: 'fake',
  inputSchema: { type: 'object', fields: { request: { schema: { type: 'string' }, required: true } } },
  steps: [
    { id: 'prepare', name: 'Prepare', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'Prepare context', outputSchema: { type: 'string' } },
    { id: 'apply', name: 'Apply', kind: 'agent', model: 'fake-1', effort: 'medium', instructions: 'Broken configuration', outputSchema: { type: 'string' } },
  ],
  edges: [{ id: 'next', from: 'prepare', to: 'apply', outcome: 'success' }],
};
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out');
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-saved-fix-'));
  const store = new TranscriptStore(root), workflows = new WorkflowStore(root), secrets = new SecretStore(root), config = new ConfigStore(root);
  const host = new SessionHost({ store });
  const backend = new FakeBackend();
  host.registerBackend(backend);
  // Agent-only execution does not require a code runtime.
  const createService = () => new WorkflowExecutionService(host, workflows, secrets, config, join(root, 'unused-runtime.cjs'));
  const service = createService();
  const id = await host.create({ scope: tmpdir(), backend: 'fake' });
  t.after(async () => { await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  workflows.saveDefinition(definition);
  const started = await service.start({ sessionId: id, definition, input: { request: 'original parameter' } });
  await until(() => backend.latest.workflowSubagents.length === 1);
  backend.latest.workflowSubagents[0]!.complete('retained upstream context');
  await until(() => backend.latest.workflowSubagents.length === 2);
  backend.latest.workflowSubagents[1]!.fail();
  await service.scheduler.wait(id, started.execution.id);
  const corrected = structuredClone(definition);
  const target = corrected.steps[1]!;
  if (target.kind !== 'agent') throw new Error();
  target.instructions = 'Corrected configuration';
  workflows.saveDefinition(corrected);
  const eid = started.execution.id;
  return { root, host, backend, store, workflows, secrets, config, service, id, eid, corrected, createService };
}

test('saved corrected config resumes at the failed step after reload with original params and upstream context', async t => {
  const f = await fixture(t);
  const original = f.service.view(f.id, f.eid).execution;
  const service = f.createService();
  const parent = service.parent(f.id);
  const summary = await parent.inspect({}) as { revision: string; savedDefinition: { revision: string; changed: boolean; changedStepIds: string[] } };
  assert.equal(summary.savedDefinition.changed, true);
  assert.deepEqual(summary.savedDefinition.changedStepIds, ['apply']);
  const action = { kind: 'retry-updated' as const, stepId: 'apply', definitionRevision: summary.savedDefinition.revision };
  await assert.rejects(parent.recover({ executionId: f.eid, revision: summary.revision, action }), /User direction required/);
  assert.deepEqual(service.view(f.id, f.eid).execution, original);
  const pending = parent.recover({ executionId: f.eid, revision: summary.revision, action, confirm: true });
  await until(() => !!reduceAll(f.host.logFor(f.id).since(0)).asking);
  const enquiry = reduceAll(f.host.logFor(f.id).since(0)).asking!;
  assert.match(JSON.stringify(enquiry), /Corrected configuration/);
  await f.host.answerEnquiry(f.id, enquiry.askId, [['Recover']]);
  await pending;
  await until(() => f.backend.latest.workflowSubagents.length === 3);
  const handle = f.backend.latest.workflowSubagents[2]!;
  assert.ok(handle.options.instructions.startsWith('Corrected configuration\n'));
  assert.deepEqual(handle.options.input, original.steps.apply!.attempts[0]!.input);
  assert.match(JSON.stringify(handle.options.input), /retained upstream context/);
  handle.complete('finished');
  const completed = await service.scheduler.wait(f.id, f.eid);
  assert.equal(completed.id, original.id);
  assert.deepEqual(completed.input, original.input);
  assert.deepEqual(completed.steps.prepare, original.steps.prepare);
  assert.equal(completed.steps.apply!.attempts.length, 2);
  assert.deepEqual(completed.steps.apply!.attempts[0], original.steps.apply!.attempts[0]);
  assert.equal(completed.status, 'completed-with-recovery');
  assert.equal(completed.definitionUpdates?.length, 1);
  assert.deepEqual(f.workflows.getExecution(f.id, f.eid), completed);
});

test('saving another correction while confirmation is pending revokes consent without altering checkpoints', async t => {
  const f = await fixture(t);
  const before = f.service.view(f.id, f.eid).execution;
  const parent = f.service.parent(f.id);
  const summary = await parent.inspect({}) as { revision: string; savedDefinition: { revision: string } };
  const pending = parent.recover({ executionId: f.eid, revision: summary.revision,
    action: { kind: 'retry-updated', stepId: 'apply', definitionRevision: summary.savedDefinition.revision }, confirm: true });
  await until(() => !!reduceAll(f.host.logFor(f.id).since(0)).asking);
  const target = f.corrected.steps[1]!;
  if (target.kind === 'agent') target.instructions = 'An unapproved later correction';
  f.workflows.saveDefinition(f.corrected);
  const rejected = assert.rejects(pending, /no longer available/);
  await f.host.answerEnquiry(f.id, reduceAll(f.host.logFor(f.id).since(0)).asking!.askId, [['Recover']]);
  await rejected;
  assert.deepEqual(f.service.view(f.id, f.eid).execution, before);
  assert.equal(f.backend.latest.workflowSubagents.length, 2);
});

test('saved incompatible edits and stale definition revisions cannot alter retained execution state', async t => {
  const f = await fixture(t);
  const before = f.service.view(f.id, f.eid).execution;
  const revision = savedDefinitionRevision(f.corrected);
  f.corrected.steps[0]!.name = 'Cannot rewrite completed work';
  f.workflows.saveDefinition(f.corrected);
  await assert.rejects(f.service.recover(f.id, f.eid, { kind: 'retry-updated', stepId: 'apply', definitionRevision: revision }), /no longer available/);
  await assert.rejects(f.service.recover(f.id, f.eid, { kind: 'retry-updated', stepId: 'apply', definitionRevision: savedDefinitionRevision(f.corrected) }), /only the recovery step/);
  assert.deepEqual(f.service.view(f.id, f.eid).execution, before);
});

test('HTTP corrected recovery accepts a pinned saved revision and rejects malformed authority', async t => {
  const f = await fixture(t);
  const server = await serve({ host: f.host, store: f.store, workflows: f.workflows, secrets: f.secrets, config: f.config, workflowExecutions: f.service, token: 'test', assets: {} });
  t.after(() => server.close());
  const recover = (definitionRevision: string) => fetch(`${server.url}/api/sessions/${f.id}/workflows/${f.eid}/recover`, {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({ kind: 'retry-updated', stepId: 'apply', definitionRevision }),
  });
  assert.equal((await recover('not-a-revision')).status, 400);
  assert.equal(f.service.view(f.id, f.eid).execution.steps.apply!.attempts.length, 1);
  assert.equal((await recover(savedDefinitionRevision(f.corrected))).status, 200);
  await until(() => f.backend.latest.workflowSubagents.length === 3);
  f.backend.latest.workflowSubagents[2]!.complete('done');
  await f.service.scheduler.wait(f.id, f.eid);
});

test('deleting the saved definition still permits ordinary recovery with the original retained copy', async t => {
  const f = await fixture(t);
  f.workflows.deleteDefinition(definition.id);
  const summary = await f.service.parent(f.id).inspect({}) as { savedDefinition: unknown };
  assert.equal(summary.savedDefinition, null);
  await f.service.recover(f.id, f.eid, { kind: 'retry', stepId: 'apply' });
  await until(() => f.backend.latest.workflowSubagents.length === 3);
  assert.ok(f.backend.latest.workflowSubagents[2]!.options.instructions.startsWith('Broken configuration\n'));
  f.backend.latest.workflowSubagents[2]!.complete('done');
  await f.service.scheduler.wait(f.id, f.eid);
});
