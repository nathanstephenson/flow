import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import type { ExecutionIdentity, WorkflowDefinition, WorkflowExecution } from '../src/protocol/workflows.ts';
import { executionAccessibleBy, executionAssociation, executionIdentity, executionOwnerKey, executionOwnerOf, executionOwnerPath, parseExecutionOwnerKey } from '../src/workflows/owner.ts';
import { executionOwner, parseExecution } from '../src/workflows/records.ts';
import { WorkflowScheduler } from '../src/workflows/scheduler.ts';
import { WorkflowStore } from '../src/workflows/store.ts';

const definition: WorkflowDefinition = {
  version: 1, id: 'definition', name: 'Workflow', backend: 'fake',
  inputSchema: { type: 'object', fields: {} },
  steps: [{ id: 'join', name: 'Join', kind: 'join' }], edges: [],
};

function record(id: string, identity: ExecutionIdentity): WorkflowExecution {
  return { ...identity, id, definition, scope: '/scope', input: {}, startedAt: 1, status: 'recovery-required', steps: { join: { status: 'pending', attempts: [] } } };
}

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-workflow-owners-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new WorkflowStore(root) };
}

function checkpoint(root: string, execution: WorkflowExecution): string {
  return join(executionOwnerPath(root, executionOwnerOf(execution)), 'workflows', execution.id + '.json');
}

test('explicit owners keep legacy keys, paths and checkpoint identities', () => {
  const manual = record('manual', { version: 1, sessionId: 'parent' });
  const scheduled = record('scheduled', { version: 2, occurrenceId: 'due', sessionId: 'parent' });
  assert.deepEqual(executionOwnerOf(manual), { kind: 'session', sessionId: 'parent' });
  assert.deepEqual(executionOwnerOf(scheduled), { kind: 'occurrence', occurrenceId: 'due' });
  assert.equal(executionOwner(manual), 'parent');
  assert.equal(executionOwner(scheduled), 'occurrence-due');
  assert.deepEqual(parseExecutionOwnerKey(executionOwnerKey(executionOwnerOf(scheduled))), executionOwnerOf(scheduled));
  assert.equal(executionOwnerPath('/state', executionOwnerOf(manual)), '/state/sessions/parent');
  assert.equal(executionOwnerPath('/state', executionOwnerOf(scheduled)), '/state/workflow-schedules/executions/due');
  assert.equal(executionAssociation(manual), undefined);
  assert.equal(executionAssociation(scheduled), 'parent');
  assert.deepEqual(executionIdentity(manual), { version: 1, sessionId: 'parent' });
  assert.deepEqual(executionIdentity(scheduled), { version: 2, occurrenceId: 'due', sessionId: 'parent' });
  assert.deepEqual(parseExecution(manual), manual);
  assert.deepEqual(parseExecution(scheduled), scheduled);
  assert.throws(() => executionIdentity({}), /owner/);
  assert.throws(() => parseExecution({ ...manual, occurrenceId: 'due' }), /owner/);
  assert.throws(() => parseExecution({ ...manual, version: 2 }), /owner/);
  assert.throws(() => executionOwnerPath('/state', { kind: 'occurrence', occurrenceId: '../bad' }), /storage ID/);
  assert.equal(executionAccessibleBy(scheduled, 'parent'), true);
  assert.equal(executionAccessibleBy(scheduled, 'other'), false);
  assert.equal(executionAccessibleBy(scheduled, 'occurrence-other'), false);
});

test('manual and occurrence checkpoints retain ownership and association after restart', t => {
  const { root, store } = fixture(t);
  const manual = record('manual', { version: 1, sessionId: 'parent' });
  const associated = record('associated', { version: 2, occurrenceId: 'due', sessionId: 'parent' });
  const sessionless = record('sessionless', { version: 2, occurrenceId: 'later' });
  for (const execution of [manual, associated, sessionless]) store.saveExecution(execution);
  assert.equal(JSON.parse(readFileSync(checkpoint(root, manual), 'utf8')).version, 1);
  assert.equal(JSON.parse(readFileSync(checkpoint(root, associated), 'utf8')).version, 2);
  assert.equal(existsSync(join(root, 'sessions', 'parent', 'workflows', associated.id + '.json')), false);
  const restored = new WorkflowStore(root);
  assert.deepEqual(restored.listOwnedExecutions('parent').map(record => record.id), ['manual']);
  assert.deepEqual(restored.listExecutions('parent').map(record => record.id), ['manual', 'associated']);
  assert.deepEqual(restored.getExecution('parent', associated.id), associated);
  assert.deepEqual(restored.getExecution('occurrence-due', associated.id), associated);
  assert.deepEqual(restored.getExecution('occurrence-later', sessionless.id), sessionless);
  assert.throws(() => restored.getExecution('other', associated.id));
  assert.throws(() => restored.getExecution('parent', sessionless.id));
  assert.throws(() => restored.getExecution('occurrence-later', associated.id));
  assert.throws(() => restored.getExecution('occurrence-due', manual.id));
});

test('saving an association change updates the local index without moving its checkpoint', t => {
  const { root, store } = fixture(t);
  const execution = record('scheduled', { version: 2, occurrenceId: 'due' });
  store.saveExecution(execution);
  assert.deepEqual(store.listExecutions('first'), []);
  execution.sessionId = 'first';
  store.saveExecution(execution);
  assert.equal(store.getExecution('first', execution.id).id, execution.id);
  execution.sessionId = 'second';
  store.saveExecution(execution);
  assert.deepEqual(store.listExecutions('first'), []);
  assert.throws(() => store.getExecution('first', execution.id));
  assert.equal(store.getExecution('second', execution.id).id, execution.id);
  delete execution.sessionId;
  store.saveExecution(execution);
  assert.deepEqual(store.listExecutions('second'), []);
  assert.ok(existsSync(checkpoint(root, execution)));
});

test('session-local checkpoint reads do not grow with unrelated occurrences', t => {
  const { root, store } = fixture(t);
  store.saveExecution(record('manual', { version: 1, sessionId: 'parent' }));
  store.saveExecution(record('associated', { version: 2, occurrenceId: 'due', sessionId: 'parent' }));
  for (let index = 0; index < 30; index++) store.saveExecution(record(`unrelated-${index}`, { version: 2, occurrenceId: `other-${index}` }));
  const restored = new WorkflowStore(root);
  const reads: string[] = [];
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0]));
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let query = 0; query < 3; query++) {
    reads.length = 0;
    assert.equal(restored.listExecutions('parent').length, 2);
    assert.equal(reads.length, 2);
    reads.length = 0;
    assert.equal(restored.getExecution('parent', 'associated').id, 'associated');
    assert.equal(reads.length, 1);
    reads.length = 0;
    assert.deepEqual(restored.listExecutions('empty'), []);
    assert.equal(reads.length, 0);
  }
});

test('deleting an occurrence removes its owner and every association without deleting Agent Sessions', t => {
  const { root, store } = fixture(t);
  const transcripts = new TranscriptStore(root);
  for (const sessionId of ['first', 'second']) {
    transcripts.writeMeta({ id: sessionId, scope: '/scope', backend: 'fake', title: sessionId, createdAt: '', updatedAt: '' });
    store.saveExecution(record('manual', { version: 1, sessionId }));
  }
  store.saveExecution(record('shared', { version: 2, occurrenceId: 'due', sessionId: 'first' }));
  store.saveExecution(record('other', { version: 2, occurrenceId: 'due', sessionId: 'second' }));
  store.saveExecution(record('shared', { version: 2, occurrenceId: 'retained', sessionId: 'first' }));
  const restored = new WorkflowStore(root);
  restored.deleteOwner({ kind: 'occurrence', occurrenceId: 'due' });
  restored.deleteOwner({ kind: 'occurrence', occurrenceId: 'due' });
  assert.equal(existsSync(restored.ownerPath('occurrence-due')), false);
  assert.deepEqual(restored.listSessionIds().sort(), ['first', 'second']);
  for (const sessionId of restored.listSessionIds()) assert.equal(transcripts.readMeta(sessionId)?.id, sessionId);
  for (const current of [restored, new WorkflowStore(root)]) {
    assert.deepEqual(current.listOwnerIds().sort(), ['first', 'occurrence-retained', 'second']);
    assert.deepEqual(current.listExecutions('first').map(execution => execution.id), ['manual', 'shared']);
    assert.deepEqual(current.listExecutions('second').map(execution => execution.id), ['manual']);
    assert.equal(executionOwnerKey(executionOwnerOf(current.getExecution('first', 'shared'))), 'occurrence-retained');
    assert.throws(() => current.getExecution('second', 'other'));
  }
});

test('Agent Session Reap removes its workflow owner through TranscriptStore deletion', async t => {
  const { root, store } = fixture(t);
  const transcripts = new TranscriptStore(root);
  transcripts.onSessionDeleted = sessionId => store.deleteOwner({ kind: 'session', sessionId });
  const host = new SessionHost({ store: transcripts, retention: 1 });
  host.registerBackend(new FakeBackend());
  t.after(() => host.shutdown());
  const sessionId = await host.create({ scope: tmpdir(), backend: 'fake' });
  store.saveExecution(record('manual', { version: 1, sessionId }));
  const scheduled = record('scheduled', { version: 2, occurrenceId: 'retained', sessionId });
  store.saveExecution(scheduled);
  await host.settle(sessionId);
  assert.deepEqual(await host.reap(Date.now() + 1000), [sessionId]);
  assert.deepEqual(store.listSessionIds(), []);
  assert.deepEqual(store.listOwnerIds(), ['occurrence-retained']);
  assert.deepEqual(store.listOwnedExecutions({ kind: 'session', sessionId }), []);
  assert.deepEqual(store.getExecution('occurrence-retained', 'scheduled'), scheduled);
  store.deleteOwner('occurrence-retained');
  assert.deepEqual(store.listExecutions(sessionId), []);
  assert.deepEqual(store.listOwners(), []);
});

test('deleted owners do not add historical traversal to owner or association queries', t => {
  const { root, store } = fixture(t);
  const transcripts = new TranscriptStore(root);
  transcripts.onSessionDeleted = sessionId => store.deleteOwner({ kind: 'session', sessionId });
  store.saveExecution(record('manual', { version: 1, sessionId: 'parent' }));
  for (let index = 0; index < 30; index++) {
    const sessionId = `reaped-${index}`;
    const occurrenceId = `expired-${index}`;
    store.saveExecution(record('manual', { version: 1, sessionId }));
    store.saveExecution(record('scheduled', { version: 2, occurrenceId, sessionId: 'parent' }));
    transcripts.deleteSession(sessionId);
    store.deleteOwner({ kind: 'occurrence', occurrenceId });
  }
  const probes: string[] = [];
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (path: Parameters<typeof fs.existsSync>[0]) => {
    probes.push(String(path));
    return exists(path);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(store.listOwnerIds(), ['parent']);
  assert.deepEqual(store.listSessionIds(), ['parent']);
  assert.deepEqual(store.listExecutions('parent').map(execution => execution.id), ['manual']);
  assert.equal(probes.some(path => /reaped-|expired-/.test(path)), false);
  assert.ok(probes.length <= 3, `Expected only retained-state probes, got ${probes.length}`);
});

test('corrupt owned state remains an error without breaking unrelated local queries', t => {
  t.mock.method(console, 'error', () => {});
  const { root, store } = fixture(t);
  store.saveExecution(record('manual', { version: 1, sessionId: 'parent' }));
  const unrelated = record('unrelated', { version: 2, occurrenceId: 'other', sessionId: 'other-parent' });
  store.saveExecution(unrelated);
  const restored = new WorkflowStore(root);
  writeFileSync(checkpoint(root, unrelated), '{corrupt');
  for (let query = 0; query < 3; query++) {
    assert.equal(restored.listExecutions('parent').length, 1);
    assert.equal(restored.getExecution('parent', 'manual').id, 'manual');
    assert.throws(() => restored.listExecutions('occurrence-other'));
    assert.throws(() => restored.listExecutions('other-parent'));
  }
  assert.equal(new WorkflowStore(root).listExecutions('parent').length, 1);
});

test('startup skips unreadable checkpoints and invalid owner directories, retaining them on disk', t => {
  const logs = t.mock.method(console, 'error', () => {});
  const { root, store } = fixture(t);
  store.saveExecution(record('manual', { version: 1, sessionId: 'parent' }));
  const broken = record('broken', { version: 2, occurrenceId: 'broken' });
  store.saveExecution(broken); writeFileSync(checkpoint(root, broken), '{corrupt');
  const invalid = join(root, 'workflow-schedules', 'executions', 'x.bak'); fs.mkdirSync(join(invalid, 'workflows'), { recursive: true });
  const restored = new WorkflowStore(root);
  assert.deepEqual(restored.listExecutions('parent').map(execution => execution.id), ['manual']);
  assert.ok(restored.listOwnerIds().includes('parent'));
  assert.equal(readFileSync(checkpoint(root, broken), 'utf8'), '{corrupt'); assert.ok(existsSync(invalid));
  new WorkflowScheduler(restored, {});
  assert.equal(logs.mock.callCount(), 3);
});

test('startup rejects checkpoint identity mismatches instead of indexing another owner', t => {
  const logs = t.mock.method(console, 'error', () => {});
  const { root, store } = fixture(t);
  const execution = record('scheduled', { version: 2, occurrenceId: 'due', sessionId: 'parent' });
  store.saveExecution(execution);
  writeFileSync(checkpoint(root, execution), JSON.stringify({ ...execution, occurrenceId: 'different' }));
  assert.deepEqual(new WorkflowStore(root).listExecutions('parent'), []); assert.equal(logs.mock.callCount(), 1);
});

test('scheduler startup reads only owner records, not session-associated duplicates', t => {
  const { root, store } = fixture(t);
  store.saveExecution(record('manual', { version: 1, sessionId: 'parent' }));
  store.saveExecution(record('associated', { version: 2, occurrenceId: 'due', sessionId: 'parent' }));
  const restored = new WorkflowStore(root);
  t.mock.method(restored, 'listExecutions', () => { throw new Error('Association listing must not run during reconstruction'); });
  const scheduler = new WorkflowScheduler(restored, {});
  assert.equal(scheduler.occupied('parent'), true);
  assert.equal(scheduler.occupied('occurrence-due'), true);
  assert.equal(scheduler.get('parent', 'associated').id, 'associated');
  assert.throws(() => scheduler.get('other', 'associated'));
  assert.throws(() => scheduler.claimNaming('other', 'associated'));
  assert.throws(() => scheduler.wait('occurrence-other', 'associated'));
});

test('graph scheduler leaves occurrence readiness decisions to its executor adapter', async t => {
  const { store } = fixture(t);
  let checked = 0;
  const scheduler = new WorkflowScheduler(store, { agent: {
    check(_step, session) { checked++; assert.equal(session.sessionId, undefined); },
    async execute(context) {
      assert.deepEqual(context.owner, { kind: 'occurrence', occurrenceId: 'due' });
      return 'done';
    },
  } });
  const execution = scheduler.start({ ...definition, steps: [{ id: 'agent', name: 'Agent', kind: 'agent', model: 'fake', effort: 'medium', instructions: 'JSON', outputSchema: { type: 'string' } }] }, { occurrenceId: 'due', scope: '/scope', backend: 'fake' }, {});
  assert.equal(checked, 1);
  assert.equal((await scheduler.wait('occurrence-due', execution.id)).status, 'completed');
});
