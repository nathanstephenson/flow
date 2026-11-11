import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Json, WorkflowDefinition, WorkflowExecution, WorkflowStep } from '../src/protocol/workflows.ts';
import { deriveResultSchema } from '../src/workflows/calls.ts';
import { WorkflowScheduler, type ExecutorContext } from '../src/workflows/scheduler.ts';
import { WorkflowStore } from '../src/workflows/store.ts';

const schema = { type: 'object', fields: {} } as const;
const definition = (id: string, steps: WorkflowStep[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition => ({ version: 1, id, name: id, backend: 'fake', inputSchema: schema, steps, edges });
const leaf = (id: string): WorkflowStep => ({ id, name: id, kind: 'typescript', code: id, outputSchema: { type: 'number' } });
const call = (id: string, target: WorkflowDefinition): WorkflowStep => ({ id, name: id, kind: 'workflow', workflowId: target.id, contract: { inputSchema: target.inputSchema, outputSchema: deriveResultSchema(target) } });
const session = { sessionId: 'session', backend: 'fake', scope: '/tmp' };
function fixture(t: { after(fn: () => void): void }, execute: (context: ExecutorContext) => Promise<Json>, Store = WorkflowStore) {
  const directory = mkdtempSync(join(tmpdir(), 'nested-workflows-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const executors = { typescript: { check() {}, execute } };
  return { store, executors, scheduler: new WorkflowScheduler(store, executors) };
}

test('nested calls wait, map results and use one root slot and record', async t => {
  const seen: ExecutorContext[] = [];
  const f = fixture(t, async context => { seen.push(context); return typeof context.input === 'number' ? context.input : 7; });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [call('call', child), leaf('after')], [{ id: 'edge', from: 'call', to: 'after', outcome: 'success' }]);
  const started = f.scheduler.start(parent, session, {});
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.result, 7);
  assert.deepEqual(seen.map(context => context.step.id), ['inner', 'after']);
  assert.ok(seen[0]!.invocationId);
  assert.equal(seen[0]!.executionId, started.id);
  assert.equal(seen[1]!.invocationId, undefined);
  assert.equal(Object.keys(done.invocations!).length, 1);
  assert.equal(f.store.listExecutions(session.sessionId).length, 1);
  assert.equal(f.scheduler.occupied(session.sessionId), false);
  assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
});

test('inner recovery keeps completed outputs and does not replay the call', async t => {
  const seen: string[] = [];
  let fail = true;
  const f = fixture(t, async context => { seen.push(context.step.id); if (context.step.id === 'second' && fail) throw new Error('inner failure'); return 4; });
  const child = definition('child', [leaf('first'), leaf('second')], [{ id: 'next', from: 'first', to: 'second', outcome: 'success' }]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('call', child)]), session, {});
  const blocked = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(blocked.status, 'recovery-required');
  assert.equal(blocked.steps.call!.status, 'running');
  const invocationId = Object.keys(blocked.invocations!)[0]!;
  assert.equal(blocked.invocations![invocationId]!.steps.first!.status, 'completed');
  fail = false;
  f.scheduler.recover(session, started.id, { kind: 'retry', stepId: 'second', invocationId });
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(done.status, 'completed-with-recovery');
  assert.deepEqual(seen, ['first', 'second', 'second']);
  assert.equal(done.steps.call!.attempts.length, 1);
});

test('inner supplied output completes the existing call without replaying effects', async t => {
  let effects = 0;
  const f = fixture(t, async () => { effects++; throw new Error('stop'); });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('call', child)]), session, {});
  const blocked = await f.scheduler.wait(session.sessionId, started.id);
  const invocationId = Object.keys(blocked.invocations!)[0]!;
  f.scheduler.recover(session, started.id, { kind: 'supply', stepId: 'inner', invocationId, output: 8 });
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(done.result, 8);
  assert.equal(effects, 1);
  assert.equal(done.steps.call!.attempts.length, 1);
  assert.equal(done.invocations![invocationId]!.steps.inner!.attempts[1]!.action, 'supply');
});

test('caller loop repetitions retain one invocation per call attempt', async t => {
  const identities: string[] = [];
  const f = fixture(t, async context => { if (context.invocationId) identities.push(context.invocationId); return identities.length; });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [leaf('root'),
    { ...call('head', child), mapping: { kind: 'object', fields: {} }, repeatMapping: { kind: 'object', fields: {} } },
    { id: 'check', name: 'check', kind: 'branch', condition: { operator: 'less-than', path: [], value: 3 } },
    leaf('body'), leaf('exit'),
  ], [
    { id: 'entry', from: 'root', to: 'head', outcome: 'success' },
    { id: 'check', from: 'head', to: 'check', outcome: 'success' },
    { id: 'body', from: 'check', to: 'body', outcome: 'true' },
    { id: 'repeat', from: 'body', to: 'head', outcome: 'success' },
    { id: 'exit', from: 'check', to: 'exit', outcome: 'false' },
  ]);
  const started = f.scheduler.start(parent, session, {});
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(done.result, 3);
  assert.equal(new Set(identities).size, 3);
  assert.equal(Object.keys(done.invocations!).length, 3);
  assert.deepEqual(Object.values(done.invocations!).map(invocation => invocation.callAttempt), [1, 2, 3]);
  assert.deepEqual(done.steps.head!.attempts.map(attempt => attempt.loops?.[0]?.try), [1, 2, 3]);
  assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
});

test('captured definitions survive deletion and host restart without replay', async t => {
  let fail = true;
  const seen: string[] = [];
  const f = fixture(t, async context => { seen.push(context.step.id); if (fail) throw new Error('stop'); return 3; });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('call', child)]), session, {});
  const blocked = await f.scheduler.wait(session.sessionId, started.id);
  const invocationId = Object.keys(blocked.invocations!)[0]!;
  f.store.deleteDefinition(child.id);
  const restored = new WorkflowScheduler(f.store, f.executors);
  assert.deepEqual(seen, ['inner']);
  fail = false;
  restored.recover(session, started.id, { kind: 'retry', stepId: 'inner', invocationId });
  const done = await restored.wait(session.sessionId, started.id);
  assert.equal(done.result, 3);
  assert.deepEqual(seen, ['inner', 'inner']);
});

test('restart reconciles running descendants even when the root already requires recovery', async t => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let running = true;
  let effects = 0;
  const f = fixture(t, async context => {
    effects++;
    if (running) {
      entered();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    return 3;
  });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('call', child)]), session, {});
  await ready;
  const checkpoint = f.scheduler.get(session.sessionId, started.id);
  await f.scheduler.cancel(session.sessionId, started.id);
  checkpoint.status = 'recovery-required';
  f.store.saveExecution(checkpoint);
  const restored = new WorkflowScheduler(f.store, f.executors);
  const invocationId = Object.keys(checkpoint.invocations!)[0]!;
  assert.equal(restored.get(session.sessionId, started.id).invocations![invocationId]!.steps.inner!.status, 'interrupted');
  running = false;
  restored.recover(session, started.id, { kind: 'retry', stepId: 'inner', invocationId });
  assert.equal((await restored.wait(session.sessionId, started.id)).result, 3);
  assert.equal(effects, 2);
});

test('recovery does not launch effects after an enclosing call deadline has expired', async t => {
  let effects = 0;
  const f = fixture(t, async context => { if (context.step.id === 'handler') return 9; effects++; throw new Error('stop'); });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [{ ...call('call', child), timeoutMs: 30 }, leaf('handler')], [{ id: 'timeout', from: 'call', to: 'handler', outcome: 'timeout' }]);
  const started = f.scheduler.start(parent, session, {});
  await f.scheduler.wait(session.sessionId, started.id);
  const snapshot = await f.scheduler.interrupt(session.sessionId, started.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  const restored = new WorkflowScheduler(f.store, f.executors);
  const invocationId = Object.keys(snapshot.invocations!)[0]!;
  restored.recover(session, started.id, { kind: 'retry', stepId: 'inner', invocationId });
  assert.equal((await restored.wait(session.sessionId, started.id)).result, 9);
  assert.equal(effects, 1);
});

test('completed nested checkpoints cannot resume effects past an enclosing deadline', async t => {
  let effects = 0;
  const captured: { record?: WorkflowExecution } = {};
  class CaptureStore extends WorkflowStore {
    override saveExecution(record: WorkflowExecution): void {
      const middle = Object.values(record.invocations ?? {}).find(item => item.definitionId === 'middle');
      const grand = Object.values(record.invocations ?? {}).find(item => item.definitionId === 'grand');
      if (!captured.record && grand?.status === 'completed' && middle?.steps.nested?.status === 'running') captured.record = structuredClone(record);
      super.saveExecution(record);
    }
  }
  const f = fixture(t, async context => { if (context.step.id === 'failing') { effects++; throw new Error('stop'); } return 7; }, CaptureStore);
  const grand = definition('grand', [leaf('grandLeaf')]);
  const middle = definition('middle', [leaf('failing'), call('nested', grand)]);
  f.store.saveDefinition(grand); f.store.saveDefinition(middle);
  const started = f.scheduler.start(definition('parent', [{ ...call('outer', middle), timeoutMs: 1_000_000 }]), session, {});
  await f.scheduler.wait(session.sessionId, started.id);
  assert.ok(captured.record);
  await f.scheduler.interrupt(session.sessionId, started.id);
  f.store.saveExecution(captured.record);
  const now = captured.record.steps.outer!.attempts[0]!.deadlineAt! + 1;
  t.mock.method(Date, 'now', () => now);
  const restored = new WorkflowScheduler(f.store, f.executors);
  const invocationId = Object.values(captured.record.invocations!).find(item => item.definitionId === 'middle')!.id;
  restored.recover(session, started.id, { kind: 'retry', stepId: 'failing', invocationId });
  await new Promise(resolve => setImmediate(resolve));
  const observed = effects;
  await restored.cancel(session.sessionId, started.id);
  assert.equal(observed, 1);
});

test('queued descendants do not start effects after the call deadline', async t => {
  let now = Date.now(), effects = 0;
  t.mock.method(Date, 'now', () => now);
  class AdvanceStore extends WorkflowStore {
    override saveExecution(record: WorkflowExecution): void {
      const deadline = record.steps.call?.attempts.at(-1)?.deadlineAt;
      if (deadline !== undefined && Object.values(record.invocations ?? {}).some(item => item.steps.inner?.status === 'running')) now = deadline + 1;
      super.saveExecution(record);
    }
  }
  const f = fixture(t, async () => { effects++; return 7; }, AdvanceStore);
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [{ ...call('call', child), timeoutMs: 1_000_000 }]), session, {});
  await new Promise(resolve => setImmediate(resolve));
  const observed = effects;
  await f.scheduler.cancel(session.sessionId, started.id);
  assert.equal(observed, 0);
});

test('input persistence cannot dispatch descendant effects after the call deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1_000, effects = 0, advanced = false;
  t.mock.method(Date, 'now', () => now);
  class AdvanceInputStore extends WorkflowStore {
    override saveExecution(record: WorkflowExecution): void {
      const deadline = record.steps.call?.attempts.at(-1)?.deadlineAt;
      const input = Object.values(record.invocations ?? {})[0]?.steps.inner?.attempts.at(-1)?.input;
      if (!advanced && deadline !== undefined && input && typeof input === 'object' && !Array.isArray(input) && input.ready === true) {
        advanced = true;
        now = deadline + 1;
      }
      super.saveExecution(record);
    }
  }
  const f = fixture(t, async context => { if (context.step.id === 'handler') return 9; effects++; return 7; }, AdvanceInputStore);
  const child = definition('child', [{ ...leaf('inner'), inputSchema: { type: 'object', fields: { ready: { schema: { type: 'boolean' }, default: true } } } }]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [{ ...call('call', child), timeoutMs: 1_000 }, leaf('handler')], [{ id: 'timeout', from: 'call', to: 'handler', outcome: 'timeout' }]);
  const started = f.scheduler.start(parent, session, {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(advanced, true);
    assert.equal(effects, 0);
    const attempt = f.scheduler.get(session.sessionId, started.id).steps.call!.attempts[0]!;
    assert.equal(attempt.deadlineAt, attempt.startedAt + 1_000);
    t.mock.timers.tick(1_000);
    const done = await f.scheduler.wait(session.sessionId, started.id);
    assert.equal(done.steps.call!.status, 'timed-out');
    assert.equal(done.status, 'completed-with-recovery');
    assert.equal(done.result, 9);
    assert.equal(Object.values(done.invocations!)[0]!.status, 'cancelled');
    assert.equal(f.scheduler.hasPendingDeadline(session.sessionId, started.id), false);
    assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
  } finally { await f.scheduler.cancel(session.sessionId, started.id); }
});

for (const kind of ['retry', 'supply'] as const) test(`interrupt then ${kind} after a timeout storage failure retains a readable checkpoint`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  let failOnce = true, effects = 0;
  let entered!: () => void, retried!: () => void, finish!: (value: number) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const retryReady = new Promise<void>(resolve => { retried = resolve; });
  const output = new Promise<number>(resolve => { finish = resolve; });
  class FailTimeoutStore extends WorkflowStore {
    override saveExecution(record: WorkflowExecution): void {
      if (failOnce && record.steps.call?.status === 'timed-out') { failOnce = false; throw new Error('disk full'); }
      super.saveExecution(record);
    }
  }
  const f = fixture(t, async context => {
    if (++effects > 1) { retried(); return output; }
    entered();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return 7;
  }, FailTimeoutStore);
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [{ ...call('call', child), timeoutMs: 1_000 }]), session, {});
  try {
    await ready;
    t.mock.timers.tick(1_000);
    await assert.rejects(f.scheduler.wait(session.sessionId, started.id), /disk full/);
    const cancelled = Object.values(f.scheduler.get(session.sessionId, started.id).invocations!)[0]!;
    t.mock.timers.tick(100);
    const interrupted = await f.scheduler.interrupt(session.sessionId, started.id);
    assert.deepEqual(interrupted.invocations![cancelled.id], cancelled);
    f.scheduler.recover(session, started.id, kind === 'retry' ? { kind, stepId: 'call' } : { kind, stepId: 'call', output: 7 });
    assert.doesNotThrow(() => f.store.getExecution(session.sessionId, started.id));
    if (kind === 'retry') {
      await retryReady;
      t.mock.timers.tick(0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.scheduler.get(session.sessionId, started.id).steps.call!.status, 'running');
      finish(7);
    }
    const done = await f.scheduler.wait(session.sessionId, started.id);
    assert.equal(done.result, 7);
    assert.equal(effects, kind === 'retry' ? 2 : 1);
    assert.deepEqual(Object.values(done.invocations!).map(item => item.status), kind === 'retry' ? ['cancelled', 'completed'] : ['cancelled']);
    assert.deepEqual(done.invocations![cancelled.id], cancelled);
    assert.equal(f.scheduler.hasPendingDeadline(session.sessionId, started.id), false);
    assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
  } finally { finish(7); await f.scheduler.cancel(session.sessionId, started.id); }
});

test('interruption waits for a timed-out subtree already cancelling and preserves its history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  let entered!: () => void, aborted!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const stopping = new Promise<void>(resolve => { aborted = resolve; });
  const f = fixture(t, async context => {
    entered();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { finish = resolve; aborted(); }, { once: true }));
    return 7;
  });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [{ ...call('call', child), timeoutMs: 1_000 }]), session, {});
  await ready;
  t.mock.timers.tick(1_000);
  await stopping;
  let stopped = false;
  const interrupted = f.scheduler.interrupt(session.sessionId, started.id).then(record => { stopped = true; return record; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(f.scheduler.occupied(session.sessionId), true);
  } finally { finish(); }
  const snapshot = await interrupted;
  const cancelled = Object.values(snapshot.invocations!)[0]!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.finishedAt, 2_000);
  assert.equal(cancelled.steps.inner!.attempts[0]!.finishedAt, 2_000);
  t.mock.timers.tick(100);
  const repeated = await f.scheduler.interrupt(session.sessionId, started.id);
  assert.deepEqual(repeated.invocations![cancelled.id], cancelled);
  const done = await f.scheduler.cancel(session.sessionId, started.id);
  assert.deepEqual(done.invocations![cancelled.id], cancelled);
  assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
});

test('successful inner recovery clears a previous root storage error', async t => {
  let broken = false;
  let effects = 0;
  class FailingStore extends WorkflowStore {
    override saveExecution(record: Parameters<WorkflowStore['saveExecution']>[0]): void {
      if (broken) throw new Error('disk full');
      super.saveExecution(record);
    }
  }
  const f = fixture(t, async () => { effects++; broken = true; return 5; }, FailingStore);
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('call', child)]), session, {});
  await assert.rejects(f.scheduler.wait(session.sessionId, started.id), /disk full/);
  const invocationId = Object.keys(f.scheduler.get(session.sessionId, started.id).invocations!)[0]!;
  broken = false;
  f.scheduler.recover(session, started.id, { kind: 'continue', invocationId });
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(done.result, 5);
  assert.equal(effects, 1);
  assert.equal(f.scheduler.occupied(session.sessionId), false);
});

test('explicit caller ask cannot be weakened by child settings', async t => {
  const permissions: string[] = [];
  const f = fixture(t, async context => { permissions.push(context.permission); return 1; });
  const child = definition('child', [{ ...leaf('inner'), permission: 'auto-accept' }]);
  child.permission = 'auto-accept';
  f.store.saveDefinition(child);
  const parent = definition('parent', [{ ...call('call', child), permission: 'ask' }]);
  const started = f.scheduler.start(parent, session, {});
  await f.scheduler.wait(session.sessionId, started.id);
  assert.deepEqual(permissions, ['ask']);
});

test('call timeout stops descendant work before its timeout handler', async t => {
  let cleaned = false;
  const f = fixture(t, async context => {
    if (context.step.id === 'handler') { assert.equal(cleaned, true); return 9; }
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; resolve(); }, 10), { once: true }));
    return 1;
  });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [{ ...call('call', child), timeoutMs: 20 }, leaf('handler')], [{ id: 'timeout', from: 'call', to: 'handler', outcome: 'timeout' }]);
  const started = f.scheduler.start(parent, session, {});
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(done.status, 'completed-with-recovery');
  assert.equal(done.result, 9);
  assert.equal(Object.values(done.invocations!)[0]!.status, 'cancelled');
});

test('call timeout includes time waiting for inner recovery', async t => {
  const f = fixture(t, async context => { if (context.step.id === 'inner') throw new Error('recover me'); return 9; });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [{ ...call('call', child), timeoutMs: 70 }, leaf('handler')], [{ id: 'timeout', from: 'call', to: 'handler', outcome: 'timeout' }]);
  const started = f.scheduler.start(parent, session, {});
  assert.equal((await f.scheduler.wait(session.sessionId, started.id)).status, 'recovery-required');
  await new Promise(resolve => setTimeout(resolve, 100));
  const done = f.scheduler.get(session.sessionId, started.id);
  assert.equal(done.status, 'completed-with-recovery');
  assert.equal(done.result, 9);
});

test('selected-call testing runs its subtree, not root siblings or successors', async t => {
  const seen: string[] = [];
  const f = fixture(t, async context => { seen.push(context.step.id); return 1; });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const parent = definition('parent', [call('call', child), leaf('sibling'), leaf('after')], [{ id: 'edge', from: 'call', to: 'after', outcome: 'success' }]);
  const started = f.scheduler.start(parent, session, {}, 'call');
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.deepEqual(seen, ['inner']);
  assert.equal(done.status, 'completed');
  assert.equal(done.naming, undefined);
});

test('deep and repeated parallel calls keep separate identities and frozen definitions', async t => {
  const seen: ExecutorContext[] = [];
  const f = fixture(t, async context => { seen.push(context); return 2; });
  const bottom = definition('bottom', [leaf('inner')]);
  const middle = definition('middle', [call('deep', bottom)]);
  f.store.saveDefinition(bottom);
  f.store.saveDefinition(middle);
  const started = f.scheduler.start(definition('parent', [call('left', middle), call('right', middle)]), session, {});
  f.store.deleteDefinition(bottom.id);
  const done = await f.scheduler.wait(session.sessionId, started.id);
  assert.deepEqual(done.result, { left: 2, right: 2 });
  assert.equal(Object.keys(done.invocations!).length, 4);
  assert.equal(new Set(seen.map(context => context.invocationId)).size, 2);
  assert.equal(Object.values(done.invocations!).filter(invocation => invocation.parentInvocationId).length, 2);
  assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
});

test('root cancellation waits for every descendant and retains the slot during cleanup', async t => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  let cleaned = false;
  const f = fixture(t, async context => {
    entered();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { finish = () => { cleaned = true; resolve(); }; }, { once: true }));
    return 1;
  });
  const child = definition('child', [leaf('inner')]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('call', child)]), session, {});
  await ready;
  const cancelling = f.scheduler.cancel(session.sessionId, started.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.scheduler.occupied(session.sessionId), true);
  assert.equal(cleaned, false);
  finish();
  const done = await cancelling;
  assert.equal(cleaned, true);
  assert.equal(done.status, 'cancelled');
  assert.equal(Object.values(done.invocations!)[0]!.status, 'cancelled');
  assert.equal(f.scheduler.occupied(session.sessionId), false);
  assert.deepEqual(f.store.getExecution(session.sessionId, started.id), done);
});

test('nested retry-updated changes only the exact invocation and retains upstream output', async t => {
  const seen: string[] = [];
  const f = fixture(t, async context => {
    assert.equal(context.step.kind, 'typescript');
    const code = (context.step as Extract<WorkflowStep, { kind: 'typescript' }>).code;
    seen.push(code);
    if (code === 'broken') throw new Error('broken');
    return 6;
  });
  const child = definition('child', [leaf('first'), { ...leaf('second'), kind: 'typescript', code: 'broken', outputSchema: { type: 'number' } }], [{ id: 'edge', from: 'first', to: 'second', outcome: 'success' }]);
  f.store.saveDefinition(child);
  const started = f.scheduler.start(definition('parent', [call('left', child), call('right', child)]), session, {});
  const blocked = await f.scheduler.wait(session.sessionId, started.id);
  const invocationId = Object.keys(blocked.invocations!)[0]!;
  const corrected = structuredClone(child);
  (corrected.steps[1] as Extract<WorkflowStep, { kind: 'typescript' }>).code = 'fixed';
  const { savedDefinitionRevision } = await import('../src/workflows/recovery.ts');
  f.scheduler.recover(session, started.id, { kind: 'retry-updated', stepId: 'second', invocationId, definitionRevision: savedDefinitionRevision(corrected) }, corrected);
  const again = await f.scheduler.wait(session.sessionId, started.id);
  assert.equal(again.status, 'recovery-required');
  assert.equal(again.invocations![invocationId]!.status, 'completed-with-recovery');
  assert.equal(Object.values(again.invocations!).filter(invocation => invocation.status === 'recovery-required').length, 1);
  assert.equal(seen.filter(code => code === 'first').length, 2);
  assert.equal(seen.filter(code => code === 'fixed').length, 1);
  assert.deepEqual(again.retainedDefinitions!.child, child);
  assert.equal(again.invocations![invocationId]!.definitionUpdates!.length, 1);
  assert.deepEqual(f.store.getExecution(session.sessionId, started.id), again);
});
