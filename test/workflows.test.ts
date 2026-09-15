import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json, VisualSchema, WorkflowDefinition, WorkflowEdge, WorkflowStep } from '../src/protocol/workflows.ts';
import { validateDefinition } from '../src/workflows/graph.ts';
import { parseValue, toTypeScript, validateSchema } from '../src/workflows/schema.ts';
import { WorkflowScheduler, WorkflowStepError } from '../src/workflows/scheduler.ts';
import type { ExecutorContext, WorkflowExecutor } from '../src/workflows/scheduler.ts';
import { WorkflowStore } from '../src/workflows/store.ts';

const number: VisualSchema = { type: 'number' };
const empty: Extract<VisualSchema, { type: 'object' }> = { type: 'object', fields: {} };
const session = { sessionId: 'session', backend: 'fake', scope: '/scope' };
const agent = (id: string, outputSchema: VisualSchema = number): WorkflowStep => ({ id, name: id.toUpperCase(), kind: 'agent', instructions: id, model: 'model', effort: 'high', outputSchema });
const edge = (from: string, to: string, outcome: WorkflowEdge['outcome'] = 'success'): WorkflowEdge => ({ id: `${from}-${to}-${outcome}`, from, to, outcome });
const definition = (steps: WorkflowStep[], edges: WorkflowEdge[] = []): WorkflowDefinition => ({ version: 1, id: 'definition', name: 'Workflow', backend: 'fake', inputSchema: empty, steps, edges });
const executor = (execute: (context: ExecutorContext) => Promise<Json>): WorkflowExecutor => ({ check() {}, execute });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('workflow schemas and graphs', () => {
  it('uses declared Join input defaults in its effective output schema', () => {
    const inputSchema: VisualSchema = { type: 'object', fields: { count: { schema: number, default: 5 } } };
    const graph = validateDefinition(definition([{ id: 'join', name: 'Join', kind: 'join', inputSchema }]));
    const input = parseValue(graph.inputSchemas.get('join')!, {});
    assert.deepEqual(input, { count: 5 });
    assert.deepEqual(parseValue(graph.outputSchemas.get('join')!, input), { count: 5 });
  });

  it('validates defaults, required fields, enums, arrays and generated types', () => {
    const schema: VisualSchema = { type: 'object', fields: {
      title: { schema: { type: 'string' }, default: 'untitled' },
      count: { schema: { type: 'number', integer: true }, required: true },
      flags: { schema: { type: 'array', items: { type: 'enum', values: ['a', 'b'] } } },
    } };
    assert.deepEqual(parseValue(schema, { count: 2 }), { title: 'untitled', count: 2 });
    assert.throws(() => parseValue(schema, { count: 2.5 }));
    assert.throws(() => parseValue(schema, {}));
    assert.throws(() => parseValue(schema, { count: 2, flags: ['c'] }));
    assert.throws(() => parseValue(schema, { count: 2, unknown: true }));
    assert.equal(toTypeScript(schema), '{ "title": string; "count": number; "flags"?: Array<"a" | "b"> }');
    assert.throws(() => validateSchema({ type: 'object', fields: { x: { schema: number, default: 'wrong' } } }));
    assert.throws(() => validateSchema({ type: 'enum', values: [] }));
  });

  it('rejects cycles, unknown endpoints, duplicate identities and names, and invalid outcomes', () => {
    assert.throws(() => validateDefinition(definition([agent('a'), agent('b')], [edge('a', 'b'), edge('b', 'a')])), /DAG/);
    assert.throws(() => validateDefinition(definition([agent('a')], [edge('a', 'missing')])), /endpoint/);
    assert.throws(() => validateDefinition(definition([agent('a'), agent('a')])), /unique/);
    assert.throws(() => validateDefinition(definition([agent('a'), { ...agent('b'), name: 'A' }])), /unique/);
    assert.throws(() => validateDefinition(definition([agent('a'), agent('b')], [edge('a', 'b', 'true')])), /outcome/);
  });

  it('rejects reserved step IDs, names, schema fields and mapping keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => validateDefinition(definition([{ ...agent('a'), id: key }])), /Reserved dictionary key/);
      assert.throws(() => validateDefinition(definition([{ ...agent('a'), name: key }, { id: 'j', name: 'Join', kind: 'join' }], [edge('a', 'j')])), /Reserved dictionary key/);
      const schema: VisualSchema = { type: 'object', fields: Object.fromEntries([[key, { schema: number }]]) };
      assert.throws(() => validateSchema(schema), /Reserved dictionary key/);
      assert.throws(() => validateDefinition(definition([{ ...agent('a'), mapping: { kind: 'object', fields: Object.fromEntries([[key, { source: 'input', path: [] }]]) } }])), /Reserved dictionary key/);
    }
  });

  it('generates mapped input types using stable IDs after renames', () => {
    const first = { ...agent('a'), name: 'Renamed' };
    const second: WorkflowStep = { ...agent('b'), mapping: { kind: 'object', fields: {
      previous: { source: 'step', stepId: 'a', path: [] }, initial: { source: 'input', path: ['initial'] },
    } } };
    const graph = validateDefinition({ ...definition([first, second], [edge('a', 'b')]), inputSchema: { type: 'object', fields: { initial: { schema: { type: 'boolean' } } } } });
    assert.equal(toTypeScript(graph.inputSchemas.get('b')!), '{ "previous": number; "initial"?: boolean }');
  });

  it('permits guaranteed parallel outputs but rejects conditional or future references', () => {
    const joinStep: WorkflowStep = { id: 'join', name: 'Join', kind: 'join' };
    const consumer: WorkflowStep = { ...agent('c'), mapping: { kind: 'reference', reference: { source: 'step', stepId: 'a', path: [] } } };
    validateDefinition(definition([agent('a'), agent('b'), joinStep, consumer], [edge('a', 'join'), edge('b', 'join'), edge('join', 'c')]));
    assert.throws(() => validateDefinition(definition([agent('a'), consumer])), /earlier/);
    const branch: WorkflowStep = { id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } };
    assert.throws(() => validateDefinition(definition([branch, agent('a'), agent('b'), joinStep, consumer], [edge('branch', 'a', 'true'), edge('branch', 'b', 'false'), edge('a', 'join'), edge('b', 'join'), edge('join', 'c')])), /not guaranteed/);
  });

  it('rejects invalid conditions, optional direct references and incompatible mappings', () => {
    const branch: WorkflowStep = { id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'truthy', path: [] } };
    assert.throws(() => validateDefinition(definition([branch])), /boolean/);
    const mapping: WorkflowStep = { ...agent('a'), mapping: { kind: 'reference', reference: { source: 'input', path: ['value'] } } };
    assert.throws(() => validateDefinition({ ...definition([mapping]), inputSchema: { type: 'object', fields: { value: { schema: number } } } }), /required/);
    const wrong: WorkflowStep = { ...agent('a'), inputSchema: number, mapping: { kind: 'reference', reference: { source: 'input', path: [] } } };
    assert.throws(() => validateDefinition(definition([wrong])), /does not match/);
  });

  it('makes conditional join fields optional and rejects unknown mapped fields', () => {
    const branch: WorkflowStep = { id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } };
    const graph = validateDefinition(definition([branch, agent('a'), agent('b'), { id: 'join', name: 'Join', kind: 'join' }], [edge('branch', 'a', 'true'), edge('branch', 'b', 'false'), edge('a', 'join'), edge('b', 'join')]));
    assert.equal(toTypeScript(graph.outputSchemas.get('join')!), '{ "A"?: number; "B"?: number }');
    const step: WorkflowStep = { ...agent('a'), mapping: { kind: 'reference', reference: { source: 'input', path: ['missing'] } } };
    assert.throws(() => validateDefinition(definition([step])), /Unknown field/);
  });
});

describe('workflow execution', () => {
  let root: string;
  let store: WorkflowStore;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'flow-workflows-')); store = new WorkflowStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rejects incompatible unmapped inputs before saving or executing recovery paths', () => {
    let calls = 0;
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => { calls++; return 1; }) });
    const joinStep: WorkflowStep = { id: 'j', name: 'Join', kind: 'join' };
    assert.throws(() => scheduler.start(definition([{ ...agent('a'), inputSchema: number }, joinStep], [edge('a', 'j', 'failure')]), session, {}), /Input does not match/);
    assert.throws(() => scheduler.start(definition([agent('root'), { ...agent('a'), inputSchema: empty }], [edge('root', 'a')]), session, {}), /Input does not match/);
    assert.equal(calls, 0);
    assert.deepEqual(store.listExecutions(session.sessionId), []);
    assert.equal(scheduler.occupied(session.sessionId), false);
  });

  it('forgets all in-memory history only after owned work stops', async () => {
    const stopped = deferred<Json>();
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => stopped.promise) });
    const started = scheduler.start(definition([agent('a')]), session, {});
    await tick();
    assert.throws(() => scheduler.forgetSession(session.sessionId), /must stop/);
    const cancelled = scheduler.cancel(session.sessionId, started.id);
    assert.throws(() => scheduler.forgetSession(session.sessionId), /must stop/);
    assert.equal(scheduler.occupied(session.sessionId), true);
    stopped.resolve(1);
    await cancelled;
    const completed = scheduler.start(definition([agent('b')]), session, {});
    await scheduler.wait(session.sessionId, completed.id);
    const failedScheduler = new WorkflowScheduler(store, { agent: executor(async () => { throw new Error('failed'); }) });
    const failed = failedScheduler.start(definition([agent('c')]), session, {});
    await failedScheduler.wait(session.sessionId, failed.id);
    assert.equal(failedScheduler.occupied(session.sessionId), true);
    failedScheduler.forgetSession(session.sessionId);
    assert.equal(failedScheduler.occupied(session.sessionId), false);
    scheduler.forgetSession(session.sessionId);
    rmSync(join(root, 'sessions', session.sessionId), { recursive: true });
    assert.throws(() => failedScheduler.get(session.sessionId, failed.id));
    for (const id of [started.id, completed.id]) {
      assert.throws(() => scheduler.get(session.sessionId, id));
      assert.throws(() => scheduler.wait(session.sessionId, id), /Unknown workflow/);
      assert.throws(() => scheduler.recover(session, id, { kind: 'continue' }), /Unknown workflow/);
    }
    assert.equal(scheduler.occupied(session.sessionId), false);
    assert.deepEqual(store.listExecutions(session.sessionId), []);
  });

  it('persists snapshots before side effects and passes only explicit inputs and permission', async () => {
    const seen: ExecutorContext[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => {
      const saved = store.getExecution(session.sessionId, context.executionId);
      assert.equal(saved.steps[context.step.id]!.status, 'running');
      assert.deepEqual(saved.steps[context.step.id]!.attempts.at(-1)!.input, context.input);
      seen.push(context);
      return context.step.id === 'a' ? 4 : (context.input as number) + 1;
    }) });
    const started = scheduler.start(definition([agent('a'), { ...agent('b'), permission: 'ask' }], [edge('a', 'b')]), session, {});
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.result, 5);
    assert.deepEqual(seen.map(context => context.input), [{}, 4]);
    assert.deepEqual(seen.map(context => context.permission), ['auto-accept', 'ask']);
    assert.equal(seen[0]!.scope, '/scope');
    assert.equal(scheduler.occupied(session.sessionId), false);
  });

  it('runs independent roots concurrently and waits for all terminal outputs', async () => {
    const a = deferred<Json>();
    const b = deferred<Json>();
    const seen: string[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => { seen.push(context.step.id); return context.step.id === 'a' ? a.promise : b.promise; }) });
    const started = scheduler.start(definition([agent('a'), agent('b')]), session, {});
    await tick();
    assert.deepEqual(seen, ['a', 'b']);
    a.resolve(1);
    await tick();
    assert.equal(scheduler.get(session.sessionId, started.id).status, 'running');
    b.resolve(2);
    assert.deepEqual((await scheduler.wait(session.sessionId, started.id)).result, { A: 1, B: 2 });
  });

  it('skips unselected paths and joins only selected outputs', async () => {
    const seen: string[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => { seen.push(context.step.id); return 3; }) });
    const branch: WorkflowStep = { id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'truthy', path: ['flag'] } };
    const workflow = { ...definition([branch, agent('yes'), agent('no'), { id: 'join', name: 'Join', kind: 'join' }], [edge('branch', 'yes', 'true'), edge('branch', 'no', 'false'), edge('yes', 'join'), edge('no', 'join')]), inputSchema: { type: 'object' as const, fields: { flag: { schema: { type: 'boolean' as const }, required: true } } } };
    const started = scheduler.start(workflow, session, { flag: true });
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { YES: 3 });
    assert.equal(result.steps.no!.status, 'skipped');
    assert.deepEqual(seen, ['yes']);
  });

  it('retains an unconnected selected branch as a terminal result', async () => {
    const scheduler = new WorkflowScheduler(store, {});
    const workflow = definition([{ id: 'branch', name: 'Branch', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } }]);
    const started = scheduler.start(workflow, session, {});
    assert.equal((await scheduler.wait(session.sessionId, started.id)).result, true);
  });

  it('lets independent branches finish after failure and blocks dependents', async () => {
    const slow = deferred<Json>();
    const seen: string[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => {
      seen.push(context.step.id);
      if (context.step.id === 'a') throw new Error('failure');
      return slow.promise;
    }) });
    const started = scheduler.start(definition([agent('a'), agent('b'), agent('dependent')], [edge('a', 'dependent')]), session, {});
    await tick();
    assert.equal(scheduler.get(session.sessionId, started.id).status, 'running');
    slow.resolve(8);
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'recovery-required');
    assert.equal(result.steps.b!.output, 8);
    assert.equal(result.steps.dependent!.status, 'blocked');
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(scheduler.occupied(session.sessionId), true);
    assert.throws(() => scheduler.start(definition([agent('new')]), session, {}), /occupied/);
  });

  it('handles failure with original input, error, partial output and explicit rejoin', async () => {
    const seen: Record<string, Json> = {};
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => {
      seen[context.step.id] = context.input;
      if (context.step.id === 'a') throw new WorkflowStepError('broken', 7);
      return context.step.id === 'repair' ? 9 : 11;
    }) });
    const started = scheduler.start(definition([agent('a'), agent('normal'), agent('repair'), { id: 'join', name: 'Join', kind: 'join' }], [edge('a', 'normal'), edge('a', 'repair', 'failure'), edge('normal', 'join'), edge('repair', 'join')]), session, {});
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'completed-with-recovery');
    assert.deepEqual(result.result, { REPAIR: 9 });
    assert.deepEqual(seen.repair, { input: {}, error: { kind: 'failure', message: 'broken' }, partialOutput: 7 });
    assert.equal(result.steps.normal!.status, 'skipped');
    assert.equal(result.steps.a!.attempts[0]!.error!.message, 'broken');
  });

  it('requires manual recovery when the handling path fails', async () => {
    const seen: string[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => { seen.push(context.step.id); throw new Error('broken'); }) });
    const started = scheduler.start(definition([agent('a'), agent('repair'), agent('again')], [edge('a', 'repair', 'failure'), edge('repair', 'again', 'failure')]), session, {});
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'recovery-required');
    assert.deepEqual(seen, ['a', 'repair']);
    assert.throws(() => scheduler.recover(session, started.id, { kind: 'supply', stepId: 'a', output: 1 }), /handling step/);
    scheduler.recover(session, started.id, { kind: 'supply', stepId: 'repair', output: 2 });
    const recovered = await scheduler.wait(session.sessionId, started.id);
    assert.equal(recovered.status, 'completed-with-recovery');
    assert.equal(recovered.result, 2);
  });

  it('routes timeout separately and waits for executor cancellation before recovery', async () => {
    let stopped = false;
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => {
      if (context.step.id === 'a') return new Promise((_, reject) => context.signal.addEventListener('abort', () => {
        setTimeout(() => { stopped = true; reject(new WorkflowStepError('aborted', 4)); }, 5);
      }, { once: true }));
      assert.equal(stopped, true);
      assert.deepEqual(context.input, { input: {}, error: { kind: 'timeout', message: 'Step timed out' }, partialOutput: 4 });
      return 5;
    }) });
    const started = scheduler.start(definition([{ ...agent('a'), timeoutMs: 5 }, agent('timeout'), agent('failure')], [edge('a', 'timeout', 'timeout'), edge('a', 'failure', 'failure')]), session, {});
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'completed-with-recovery');
    assert.equal(result.steps.failure!.status, 'skipped');
    assert.equal(result.result, 5);
  });

  it('cancels running work without starting successors or recovery and holds the slot until stopped', async () => {
    const stopped = deferred<Json>();
    const seen: string[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => {
      seen.push(context.step.id);
      context.signal.addEventListener('abort', () => stopped.resolve(1), { once: true });
      return stopped.promise;
    }) });
    const started = scheduler.start(definition([agent('a'), agent('next'), agent('repair')], [edge('a', 'next'), edge('a', 'repair', 'failure')]), session, {});
    await tick();
    const cancelled = scheduler.cancel(session.sessionId, started.id);
    assert.equal(scheduler.occupied(session.sessionId), true);
    const result = await cancelled;
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(seen, ['a']);
    assert.equal(scheduler.occupied(session.sessionId), false);
    assert.equal(result.steps.a!.attempts[0]!.output, undefined);
  });

  it('can cancel before the executor starts', async () => {
    let calls = 0;
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => { calls++; return 1; }) });
    const started = scheduler.start(definition([agent('a')]), session, {});
    await scheduler.cancel(session.sessionId, started.id);
    assert.equal(calls, 0);
    assert.equal(store.getExecution(session.sessionId, started.id).status, 'cancelled');
  });

  it('validates outputs and shell accepted exit codes', async () => {
    const scheduler = new WorkflowScheduler(store, { shell: executor(async () => ({ exitCode: 1, stdout: 'test failure', stderr: '' })) });
    const shell: WorkflowStep = { id: 'shell', name: 'Shell', kind: 'shell', command: 'test' };
    const failed = scheduler.start(definition([shell]), session, {});
    assert.equal((await scheduler.wait(session.sessionId, failed.id)).status, 'recovery-required');
    await scheduler.cancel(session.sessionId, failed.id);
    const accepted = scheduler.start(definition([{ ...shell, acceptedExitCodes: [0, 1] }]), session, {});
    assert.equal((await scheduler.wait(session.sessionId, accepted.id)).status, 'completed');
    const invalid = new WorkflowScheduler(store, { agent: executor(async () => 'not a number') });
    const started = invalid.start(definition([agent('a')]), session, {});
    assert.equal((await invalid.wait(session.sessionId, started.id)).status, 'recovery-required');
  });

  it('blocks unavailable executors, external sandboxes, adapter mismatches and Project restrictions', () => {
    const scheduler = new WorkflowScheduler(store, {});
    assert.throws(() => scheduler.start(definition([agent('a')]), session, {}), /unavailable/);
    assert.throws(() => scheduler.start(definition([agent('a')]), { ...session, backend: 'other' }, {}), /mismatch/);
    assert.throws(() => scheduler.start({ ...definition([agent('a')]), projectId: 'project' }, session, {}), /Project/);
    const typescript: WorkflowStep = { id: 'ts', name: 'TS', kind: 'typescript', code: 'return 1', outputSchema: number };
    const noSandbox = new WorkflowScheduler(store, { typescript: {
      check() { throw new Error('Enabled external sandbox is unavailable'); },
      async execute() { assert.fail('Must not execute without the enabled sandbox'); },
    } });
    assert.throws(() => noSandbox.start(definition([typescript]), session, {}), /sandbox/);
    assert.equal(scheduler.occupied(session.sessionId), false);
    assert.deepEqual(store.listExecutions(session.sessionId), []);
  });

  it('tests exactly one step with sample validation and no recovery or successors', async () => {
    const seen: Json[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => { seen.push(context.input); throw new Error('test failed'); }) });
    const workflow = definition([agent('a'), { ...agent('b'), inputSchema: number }, agent('c')], [edge('a', 'b'), edge('b', 'c', 'failure')]);
    assert.throws(() => scheduler.start(workflow, session, 'bad', 'b'));
    const started = scheduler.start(workflow, session, 5, 'b');
    assert.throws(() => scheduler.start(workflow, session, 5, 'b'), /occupied/);
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.deepEqual(seen, [5]);
    assert.equal(result.steps.a!.status, 'skipped');
    assert.equal(result.steps.c!.status, 'skipped');
    scheduler.recover(session, started.id, { kind: 'supply', stepId: 'b', output: 6 });
    assert.equal((await scheduler.wait(session.sessionId, started.id)).result, 6);
    assert.deepEqual(seen, [5]);
  });

  it('recovers an interrupted step without repeating completed parallel work', async () => {
    const calls: string[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => {
      calls.push(context.step.id);
      if (context.step.id === 'b') return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return 3;
    }) });
    const started = scheduler.start(definition([agent('a'), agent('b'), { id: 'join', name: 'Join', kind: 'join' }], [edge('a', 'join'), edge('b', 'join')]), session, {});
    await tick();
    await scheduler.interrupt(session.sessionId, started.id);
    assert.equal(scheduler.occupied(session.sessionId), true);
    const restarted = new WorkflowScheduler(store, { agent: executor(async context => { calls.push(context.step.id); return 4; }) });
    assert.equal(restarted.get(session.sessionId, started.id).status, 'recovery-required');
    assert.throws(() => restarted.recover(session, started.id, { kind: 'supply', stepId: 'b', output: 'bad' }));
    assert.equal(restarted.get(session.sessionId, started.id).steps.b!.attempts.length, 1);
    restarted.recover(session, started.id, { kind: 'retry', stepId: 'b' });
    const result = await restarted.wait(session.sessionId, started.id);
    assert.deepEqual(result.result, { A: 3, B: 4 });
    assert.deepEqual(calls, ['a', 'b', 'b']);
    assert.equal(result.steps.b!.attempts[0]!.error!.kind, 'interrupted');
    assert.equal(result.steps.b!.attempts[1]!.action, 'retry');
    assert.equal(result.status, 'completed-with-recovery');
  });

  it('reconciles a durable running snapshot without automatic execution', async () => {
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => 1) });
    const started = scheduler.start(definition([agent('a'), agent('b')], [edge('a', 'b')]), session, {});
    const snapshot = store.getExecution(session.sessionId, started.id);
    await scheduler.wait(session.sessionId, started.id);
    store.saveExecution(snapshot);
    let calls = 0;
    const restarted = new WorkflowScheduler(store, { agent: executor(async () => { calls++; return 7; }) });
    await tick();
    assert.equal(calls, 0);
    assert.equal(restarted.get(session.sessionId, started.id).steps.a!.status, 'interrupted');
    restarted.recover(session, started.id, { kind: 'supply', stepId: 'a', output: 6 });
    const result = await restarted.wait(session.sessionId, started.id);
    assert.equal(result.result, 7);
    assert.equal(calls, 1);
    assert.equal(result.steps.a!.attempts[1]!.action, 'supply');
  });

  it('resolves mapped workflow defaults and previous outputs at execution time', async () => {
    const seen: Json[] = [];
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => { seen.push(context.input); return 3; }) });
    const workflow = { ...definition([agent('a'), { ...agent('b'), mapping: { kind: 'object' as const, fields: { previous: { source: 'step' as const, stepId: 'a', path: [] }, initial: { source: 'input' as const, path: ['value'] } } } }], [edge('a', 'b')]), inputSchema: { type: 'object' as const, fields: { value: { schema: number, default: 5 } } } };
    const started = scheduler.start(workflow, session, {});
    await scheduler.wait(session.sessionId, started.id);
    assert.deepEqual(seen, [{ value: 5 }, { previous: 3, initial: 5 }]);
  });

  it('waits for selected parallel join inputs and keeps their fields required', async () => {
    const slow = deferred<Json>();
    const scheduler = new WorkflowScheduler(store, { agent: executor(async context => context.step.id === 'a' ? 1 : slow.promise) });
    const workflow = definition([agent('a'), agent('b'), { id: 'join', name: 'Join', kind: 'join' }], [edge('a', 'join'), edge('b', 'join')]);
    assert.equal(toTypeScript(validateDefinition(workflow).outputSchemas.get('join')!), '{ "A": number; "B": number }');
    const started = scheduler.start(workflow, session, {});
    await tick();
    assert.equal(scheduler.get(session.sessionId, started.id).steps.join!.status, 'pending');
    slow.resolve(2);
    assert.deepEqual((await scheduler.wait(session.sessionId, started.id)).result, { A: 1, B: 2 });
  });

  it('collects partial recovery outputs without requiring missing successful output fields', async () => {
    const output: VisualSchema = { type: 'object', fields: { first: { schema: number, required: true }, second: { schema: number, required: true } } };
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => { throw new WorkflowStepError('partial', { first: 1 }); }) });
    const started = scheduler.start(definition([agent('a', output), { id: 'join', name: 'Join', kind: 'join' }], [edge('a', 'join', 'failure')]), session, {});
    const result = await scheduler.wait(session.sessionId, started.id);
    assert.equal(result.status, 'completed-with-recovery');
    assert.deepEqual(result.result, { A: { input: {}, error: { kind: 'failure', message: 'partial' }, partialOutput: { first: 1 } } });
  });

  it('does not run side effects after a durable write fails', async () => {
    let calls = 0;
    class FailingStore extends WorkflowStore {
      writes = 0;
      override saveExecution(record: Parameters<WorkflowStore['saveExecution']>[0]): void {
        this.writes++;
        if (this.writes > 2) throw new Error('disk full');
        super.saveExecution(record);
      }
    }
    const failingStore = new FailingStore(root);
    const scheduler = new WorkflowScheduler(failingStore, { agent: executor(async () => { calls++; return 1; }) });
    const started = scheduler.start(definition([agent('a')]), session, {});
    await assert.rejects(scheduler.wait(session.sessionId, started.id), /disk full/);
    assert.equal(calls, 0);
    assert.equal(scheduler.occupied(session.sessionId), true);
    assert.equal(store.getExecution(session.sessionId, started.id).steps.a!.status, 'running');
  });

  it('requires explicit continuation after a crash between completed steps', async () => {
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => 1) });
    const started = scheduler.start(definition([agent('a')]), session, {});
    const completed = await scheduler.wait(session.sessionId, started.id);
    completed.status = 'running';
    delete completed.finishedAt;
    delete completed.result;
    store.saveExecution(completed);
    const restarted = new WorkflowScheduler(store, {});
    assert.equal(restarted.get(session.sessionId, started.id).status, 'recovery-required');
    restarted.recover(session, started.id, { kind: 'continue' });
    assert.equal((await restarted.wait(session.sessionId, started.id)).result, 1);
  });

  it('honours executor capability checks and permits TypeScript without external sandboxing', async () => {
    const unsupported = new WorkflowScheduler(store, { agent: { check() { throw new Error('unsupported effort'); }, async execute() { return 1; } } });
    assert.throws(() => unsupported.start(definition([agent('a')]), session, {}), /unsupported effort/);
    const scheduler = new WorkflowScheduler(store, { typescript: executor(async context => {
      assert.equal(context.step.kind, 'typescript');
      return 2;
    }) });
    const started = scheduler.start(definition([{ id: 'ts', name: 'TS', kind: 'typescript', code: 'return 2', outputSchema: number }]), session, {});
    assert.equal((await scheduler.wait(session.sessionId, started.id)).result, 2);
  });

  it('keeps definition snapshots after edits and deletion and stores history below the Agent Session', async () => {
    const workflow = definition([agent('a')]);
    store.saveDefinition(workflow);
    const scheduler = new WorkflowScheduler(store, { agent: executor(async () => { throw new Error('fail'); }) });
    const started = scheduler.start(store.getDefinition(workflow.id), session, {});
    await scheduler.wait(session.sessionId, started.id);
    workflow.steps[0]!.name = 'Changed';
    store.saveDefinition(workflow);
    store.deleteDefinition(workflow.id);
    assert.equal(store.listDefinitions().length, 0);
    const restarted = new WorkflowScheduler(store, {});
    restarted.recover(session, started.id, { kind: 'supply', stepId: 'a', output: 2 });
    const result = await restarted.wait(session.sessionId, started.id);
    assert.equal(result.definition.steps[0]!.name, 'A');
    const path = join(root, 'sessions', session.sessionId, 'workflows', `${started.id}.json`);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).result, 2);
    rmSync(join(root, 'sessions', session.sessionId), { recursive: true });
    assert.deepEqual(store.listExecutions(session.sessionId), []);
    assert.throws(() => store.getExecution('../escape', started.id), /storage ID/);
  });
});
