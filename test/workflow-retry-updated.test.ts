import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json, WorkflowDefinition, WorkflowExecution, WorkflowStep } from '../src/protocol/workflows.ts';
import { WorkflowScheduler, type ExecutorContext, type WorkflowExecutor } from '../src/workflows/scheduler.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { parseExecution } from '../src/workflows/records.ts';
import { recoveryRevision, safeAutomaticRecovery, savedDefinitionRevision, validateCompatibleDefinition } from '../src/workflows/recovery.ts';

const session = { sessionId: 'session', backend: 'fake', scope: '/original-scope', projectId: '/project' };
const agent = (id: string): Extract<WorkflowStep, { kind: 'agent' }> => ({ id, name: id, kind: 'agent', instructions: id, model: 'original', effort: 'off', outputSchema: { type: 'number' } });
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to, outcome: 'success' as const });
const definition = (): WorkflowDefinition => ({ version: 1, id: 'workflow', name: 'Workflow', backend: 'fake', projectId: '/project', permission: 'ask',
  inputSchema: { type: 'object', fields: { value: { schema: { type: 'number' }, default: 9 } } },
  steps: [agent('root'), { ...agent('fix'), mapping: { kind: 'object', fields: { previous: { source: 'step', stepId: 'root', path: [] }, value: { source: 'input', path: ['value'] } } } }, agent('after')],
  edges: [edge('root', 'fix'), edge('fix', 'after')],
});
function correction(record: WorkflowExecution, instructions = 'corrected'): WorkflowDefinition {
  const next = structuredClone(record.definition);
  const target = next.steps.find(step => step.id === 'fix')!;
  assert.equal(target.kind, 'agent');
  if (target.kind === 'agent') target.instructions = instructions;
  return next;
}
const action = (candidate: WorkflowDefinition, stepId = 'fix') => ({ kind: 'retry-updated' as const, stepId, definitionRevision: savedDefinitionRevision(candidate) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let root: string;
let store: WorkflowStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'flow-updated-')); store = new WorkflowStore(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const checkpoint = (id: string) => readFileSync(join(root, 'sessions', session.sessionId, 'workflows', `${id}.json`), 'utf8');

it('retries saved corrections durably in the same execution, preserving inputs, outputs, context and prior attempts', async () => {
  const seen: ExecutorContext[] = [];
  const executor: WorkflowExecutor = { check(step) {
    // The obsolete configuration must not be preflighted during updated recovery.
    if (seen.length && step.kind === 'agent' && step.id === 'fix' && step.model === 'original') throw new Error('obsolete model unavailable');
  }, async execute(context) {
    seen.push(context);
    assert.equal(context.scope, session.scope);
    if (context.step.id === 'root') return 7;
    if (context.step.id === 'after') return (context.input as number) + 1;
    assert.deepEqual(context.input, { previous: 7, value: 9 });
    if (context.step.kind !== 'agent' || context.step.instructions !== 'corrected twice') throw new Error('bad executable configuration');
    const persisted = store.getExecution(session.sessionId, context.executionId);
    assert.equal(persisted.definitionUpdates!.length, 2);
    assert.equal(persisted.steps.fix!.attempts.at(-1)!.action, 'retry');
    return 20;
  } };
  let scheduler = new WorkflowScheduler(store, { agent: executor });
  const started = scheduler.start(definition(), session, {});
  const failed = await scheduler.wait(session.sessionId, started.id);
  const oldRoot = structuredClone(failed.steps.root);
  let candidate = correction(failed);
  const target = candidate.steps[1]!;
  if (target.kind === 'agent') Object.assign(target, { model: 'replacement', effort: 'high', timeoutMs: 12345, secrets: { KEY: 'reference' } });
  store.saveDefinition(candidate);
  candidate = store.getDefinition(candidate.id);
  scheduler = new WorkflowScheduler(new WorkflowStore(root), { agent: executor });
  const oldRevision = recoveryRevision(failed);
  scheduler.recover(session, started.id, action(candidate), candidate);
  const failedAgain = await scheduler.wait(session.sessionId, started.id);
  assert.notEqual(recoveryRevision(failedAgain), oldRevision);
  assert.equal(failedAgain.definitionUpdates![0]!.attempt, 2);
  assert.deepEqual(failedAgain.definitionUpdates![0]!.previousStep, failed.definition.steps[1]);
  assert.deepEqual(failedAgain.definitionUpdates![0]!.nextStep, candidate.steps[1]);
  assert.deepEqual(failedAgain.steps.root, oldRoot);
  candidate = correction(failedAgain, 'corrected twice');
  store.saveDefinition(candidate);
  scheduler = new WorkflowScheduler(new WorkflowStore(root), { agent: executor });
  scheduler.recover(session, started.id, action(candidate), store.getDefinition(candidate.id));
  const result = await scheduler.wait(session.sessionId, started.id);
  assert.equal(result.id, started.id);
  assert.equal(result.status, 'completed-with-recovery');
  assert.equal(result.result, 21);
  assert.deepEqual(result.input, { value: 9 });
  assert.deepEqual(result.steps.root, oldRoot);
  assert.deepEqual(result.steps.fix!.attempts.slice(0, 2), failedAgain.steps.fix!.attempts);
  assert.deepEqual(result.steps.fix!.attempts.map(attempt => attempt.input), Array(3).fill({ previous: 7, value: 9 }));
  assert.deepEqual(result.definitionUpdates!.map(update => update.attempt), [2, 3]);
  assert.deepEqual(seen.map(context => context.step.id), ['root', 'fix', 'fix', 'fix', 'after']);
  assert.equal(seen[2]!.permission, 'ask');
  assert.deepEqual(store.getExecution(session.sessionId, result.id), result);
  assert.deepEqual(new WorkflowScheduler(new WorkflowStore(root), { agent: executor }).get(session.sessionId, result.id), result);
});

it('rejects incompatible saved edits, stale authority and unavailable corrected config without any checkpoint or active mutation', async () => {
  let calls = 0;
  const executor: WorkflowExecutor = { check(step) { if (step.kind === 'agent' && step.instructions === 'unavailable') throw new Error('corrected runtime unavailable'); }, async execute(context) {
    calls++;
    if (context.step.id === 'fix') throw new Error('failed');
    return 1;
  } };
  const scheduler = new WorkflowScheduler(store, { agent: executor });
  const started = scheduler.start(definition(), session, {});
  const failed = await scheduler.wait(session.sessionId, started.id);
  const before = checkpoint(started.id);
  const mutations: Array<[string, (candidate: WorkflowDefinition) => void]> = [
    ['identity', next => { next.id = 'other'; }],
    ['backend', next => { next.backend = 'other'; }],
    ['project', next => { next.projectId = '/other'; }],
    ['name', next => { next.name = 'other'; }],
    ['global policy', next => { next.permission = 'auto-accept'; }],
    ['inputs', next => { next.inputSchema.fields.value!.default = 10; }],
    ['edges', next => { next.edges[0]!.id = 'new-edge'; }],
    ['step identity', next => { next.steps[1]!.id = 'other'; }],
    ['step kind', next => { next.steps[1] = { id: 'fix', name: 'fix', kind: 'join' }; }],
    ['step contract', next => { next.steps[1]!.inputSchema = { type: 'json' }; }],
    ['output contract', next => { const step = next.steps[1]!; if (step.kind === 'agent') step.outputSchema = { type: 'json' }; }],
    ['mapping', next => { delete next.steps[1]!.mapping; }],
    ['repeat mapping', next => { next.steps[1]!.repeatMapping = { kind: 'reference', reference: { source: 'input', path: [] } }; }],
    ['target policy', next => { next.steps[1]!.permission = 'auto-accept'; }],
    ['position', next => { next.steps[1]!.position = { x: 1, y: 2 }; }],
    ['other completed step', next => { const step = next.steps[0]!; if (step.kind === 'agent') step.instructions = 'edited'; }],
    ['other pending step', next => { const step = next.steps[2]!; if (step.kind === 'agent') step.instructions = 'edited'; }],
    ['extra step', next => { next.steps.push(agent('extra')); }],
    ['order', next => { next.steps.reverse(); }],
    ['loop policy', next => { next.loopSettings = { fix: { maxTries: 1 } }; }],
    ['invalid config', next => { next.steps[1]!.timeoutMs = -1; }],
  ];
  const unchanged = () => {
    assert.equal(checkpoint(started.id), before);
    assert.deepEqual(scheduler.get(session.sessionId, started.id), failed);
    assert.equal(calls, 2);
  };
  for (const [label, mutate] of mutations) {
    const candidate = correction(failed);
    mutate(candidate);
    assert.throws(() => validateCompatibleDefinition(failed.definition, candidate, 'fix'), label);
    assert.throws(() => scheduler.recover(session, started.id, action(candidate), candidate), label);
    unchanged();
  }
  const valid = correction(failed);
  assert.throws(() => scheduler.recover(session, started.id, action(valid)), /requires a saved/);
  assert.throws(() => scheduler.recover(session, started.id, { ...action(valid), definitionRevision: 'stale' }, valid), /revision changed/);
  assert.throws(() => scheduler.recover(session, started.id, { kind: 'retry', stepId: 'fix' }, valid), /requires retry-updated/);
  assert.throws(() => scheduler.recover({ ...session, scope: '/other' }, started.id, action(valid), valid), /original Scope/);
  const unavailable = correction(failed, 'unavailable');
  assert.throws(() => scheduler.recover(session, started.id, action(unavailable), unavailable), /runtime unavailable/);
  assert.throws(() => scheduler.recover(session, started.id, action(failed.definition, 'root'), failed.definition), /does not require recovery/);
  assert.throws(() => scheduler.recover(session, started.id, action(failed.definition, 'after'), failed.definition), /does not require recovery/);
  unchanged();
  scheduler.recover(session, started.id, action(valid), valid);
  await scheduler.wait(session.sessionId, started.id);
});

it('uses exactly ordinary retry eligibility for handled failures and failed handling steps', async () => {
  const candidate = definition();
  candidate.edges = [{ ...edge('root', 'fix'), outcome: 'failure' }, edge('fix', 'after')];
  delete candidate.steps[1]!.mapping;
  const executor: WorkflowExecutor = { check() {}, async execute(context) {
    if (context.step.id === 'root' || (context.step.kind === 'agent' && context.step.instructions === 'fix')) throw new Error('failed');
    return 3;
  } };
  const scheduler = new WorkflowScheduler(store, { agent: executor });
  const started = scheduler.start(candidate, session, {});
  const failed = await scheduler.wait(session.sessionId, started.id);
  assert.equal(failed.steps.fix!.recovery, true);
  const before = checkpoint(started.id);
  assert.throws(() => scheduler.recover(session, started.id, action(candidate, 'root'), candidate), /handled failure/);
  assert.equal(checkpoint(started.id), before);
  const fixed = correction(failed);
  scheduler.recover(session, started.id, action(fixed), fixed);
  const completed = await scheduler.wait(session.sessionId, started.id);
  assert.equal(completed.status, 'completed-with-recovery');
  assert.deepEqual(completed.steps.root, failed.steps.root);
  assert.deepEqual(completed.steps.fix!.attempts[1]!.input, failed.steps.fix!.attempts[0]!.input);
});

for (const kind of ['interrupted', 'timed-out'] as const) it(`recovers a durable ${kind} step using corrected code and the retained input`, async () => {
  const candidate: WorkflowDefinition = { ...definition(), steps: [{ id: 'fix', name: 'fix', kind: 'typescript', code: 'broken', outputSchema: { type: 'number' }, ...(kind === 'timed-out' ? { timeoutMs: 5 } : {}) }], edges: [] };
  const executor: WorkflowExecutor = { check() {}, async execute(context) {
    if (context.step.kind === 'typescript' && context.step.code === 'fixed') { assert.deepEqual(context.input, { value: 9 }); return 9; }
    return new Promise<Json>((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } };
  let scheduler = new WorkflowScheduler(store, { typescript: executor });
  const started = scheduler.start(candidate, session, {});
  await tick();
  const failed = kind === 'interrupted' ? await scheduler.interrupt(session.sessionId, started.id) : await scheduler.wait(session.sessionId, started.id);
  assert.equal(failed.steps.fix!.status, kind);
  scheduler = new WorkflowScheduler(new WorkflowStore(root), { typescript: executor });
  const fixed = structuredClone(candidate);
  if (fixed.steps[0]!.kind === 'typescript') fixed.steps[0]!.code = 'fixed';
  scheduler.recover(session, started.id, action(fixed), fixed);
  const completed = await scheduler.wait(session.sessionId, started.id);
  assert.equal(completed.result, 9);
  assert.deepEqual(completed.steps.fix!.attempts[0], failed.steps.fix!.attempts[0]);
  assert.equal(store.getExecution(session.sessionId, started.id).definitionUpdates![0]!.attempt, 2);
});

it('preserves loop try identities, grants, guidance and completed work through a saved correction', async () => {
  const candidate: WorkflowDefinition = { ...definition(), steps: [agent('root'), agent('head'), { id: 'check', name: 'check', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } }, agent('fix'), agent('exit')],
    edges: [edge('root', 'head'), edge('head', 'check'), { ...edge('check', 'fix'), outcome: 'true' }, edge('fix', 'head'), { ...edge('check', 'exit'), outcome: 'false' }], loopSettings: { head: { maxTries: 1 } } };
  const seen: ExecutorContext[] = [];
  const executor: WorkflowExecutor = { check() {}, async execute(context) {
    seen.push(context);
    if (context.step.id === 'head') return context.input === 0 ? 0 : 1;
    if (context.step.id !== 'fix') return 5;
    if (context.step.kind !== 'agent' || !context.step.instructions.startsWith('corrected')) throw new Error('broken corrective step');
    assert.match(context.step.instructions, /Extra try guidance:\nkeep guidance/);
    const persisted = store.getExecution(session.sessionId, context.executionId);
    assert.deepEqual(persisted.steps.fix!.attempts.at(-1)!.loops, [{ headerId: 'head', activation: 1, try: 2 }]);
    assert.equal(persisted.definitionUpdates![0]!.attempt, 2);
    return 0;
  } };
  let scheduler = new WorkflowScheduler(store, { agent: executor });
  const started = scheduler.start(candidate, session, {});
  await scheduler.wait(session.sessionId, started.id);
  scheduler.recover(session, started.id, { kind: 'extend-loop', headerId: 'head', activation: 1, try: 1, guidance: 'keep guidance' });
  const failed = await scheduler.wait(session.sessionId, started.id);
  const fixed = correction(failed);
  assert.equal(failed.loops!.head!.try, 2);
  const incompatible = structuredClone(fixed);
  incompatible.loopSettings!.head!.maxTries = 4;
  const before = checkpoint(started.id);
  assert.throws(() => scheduler.recover(session, started.id, action(incompatible), incompatible));
  assert.equal(checkpoint(started.id), before);
  scheduler = new WorkflowScheduler(new WorkflowStore(root), { agent: executor });
  scheduler.recover(session, started.id, action(fixed), fixed);
  const completed = await scheduler.wait(session.sessionId, started.id);
  assert.equal(completed.status, 'completed-with-recovery');
  assert.deepEqual(completed.loops!.head!.grants, failed.loops!.head!.grants);
  assert.equal(completed.loops!.head!.try, 2);
  assert.deepEqual(completed.steps.root, failed.steps.root);
  assert.deepEqual(completed.steps.head!.attempts[0], failed.steps.head!.attempts[0]);
  assert.deepEqual(completed.steps.fix!.attempts.map(attempt => [attempt.action, attempt.loops, attempt.input]), [['execute', [{ headerId: 'head', activation: 1, try: 2 }], true], ['retry', [{ headerId: 'head', activation: 1, try: 2 }], true]]);
  assert.equal(seen.filter(context => context.step.id === 'root').length, 1);
  assert.deepEqual(store.getExecution(session.sessionId, started.id), completed);
});

it('hashes saved definitions stably and invalidates recovery authority for config or audit changes; updated retry is never automatic', async () => {
  const scheduler = new WorkflowScheduler(store, { agent: { check() {}, async execute() { throw new Error('failed'); } } });
  const started = scheduler.start(definition(), session, {});
  const failed = await scheduler.wait(session.sessionId, started.id);
  assert.deepEqual(parseExecution(failed), failed); // legacy record without an audit
  const fixed = correction(failed);
  store.saveDefinition(fixed);
  const reordered = Object.fromEntries(Object.entries(fixed).reverse()) as unknown as WorkflowDefinition;
  assert.equal(savedDefinitionRevision(fixed), savedDefinitionRevision(reordered));
  assert.equal(savedDefinitionRevision(fixed), savedDefinitionRevision(store.getDefinition(fixed.id)));
  const changed = structuredClone(failed);
  changed.definition = fixed;
  assert.notEqual(recoveryRevision(changed), recoveryRevision(failed));
  const audited = structuredClone(failed);
  audited.definitionUpdates = [];
  assert.notEqual(recoveryRevision(audited), recoveryRevision(failed));
  assert.equal(safeAutomaticRecovery(failed, action(fixed)), false);
  failed.definition.steps = [{ id: 'fix', name: 'fix', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } }];
  assert.equal(safeAutomaticRecovery(failed, action(fixed)), false);
});

it('keeps adopted config after a crash before retry launch, without automatically replaying work', async () => {
  const executor: WorkflowExecutor = { check() {}, async execute(context) {
    if (context.step.kind === 'agent' && context.step.instructions === 'corrected') return 42;
    throw new Error('failed');
  } };
  let scheduler = new WorkflowScheduler(store, { agent: executor });
  const started = scheduler.start(definition(), session, {});
  const failed = await scheduler.wait(session.sessionId, started.id);
  const fixed = structuredClone(failed.definition);
  if (fixed.steps[0]!.kind === 'agent') fixed.steps[0]!.instructions = 'corrected';
  // Emulate the durable correction checkpoint immediately before pump appends attempt 2.
  const checkpointRecord = structuredClone(failed);
  checkpointRecord.definition = fixed;
  checkpointRecord.definitionUpdates = [{ stepId: 'root', previousStep: failed.definition.steps[0]!, nextStep: fixed.steps[0]!, appliedAt: Date.now(), attempt: 2 }];
  checkpointRecord.steps.root!.status = 'pending';
  delete checkpointRecord.steps.root!.outcome;
  checkpointRecord.status = 'running';
  store.saveExecution(checkpointRecord);
  // Later saved edits are not implicitly adopted by continue or an ordinary retry.
  store.saveDefinition(failed.definition);
  scheduler = new WorkflowScheduler(new WorkflowStore(root), { agent: executor });
  const interrupted = scheduler.get(session.sessionId, started.id);
  assert.equal(interrupted.status, 'recovery-required');
  assert.equal(interrupted.steps.root!.attempts.length, 1);
  assert.equal(safeAutomaticRecovery(interrupted, { kind: 'continue' }), false);
  scheduler.recover(session, started.id, { kind: 'continue' });
  const result = await scheduler.wait(session.sessionId, started.id);
  assert.equal(result.steps.root!.output, 42);
  assert.equal(result.steps.root!.attempts[1]!.action, 'retry');
  assert.deepEqual(result.definitionUpdates, checkpointRecord.definitionUpdates);
  assert.deepEqual(store.getExecution(session.sessionId, result.id), result);
});

it('allows executable config by kind but never changes MCP snapshots or contracts', () => {
  const steps: Array<[WorkflowStep, WorkflowStep]> = [
    [{ id: 'fix', name: 'fix', kind: 'shell', command: 'old' }, { id: 'fix', name: 'fix', kind: 'shell', command: 'new', acceptedExitCodes: [0, 2], timeoutMs: 200, secrets: { TOKEN: 'name' } }],
    [{ id: 'fix', name: 'fix', kind: 'typescript', code: 'old', outputSchema: { type: 'number' } }, { id: 'fix', name: 'fix', kind: 'typescript', code: 'new', outputSchema: { type: 'number' } }],
    [{ id: 'fix', name: 'fix', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } }, { id: 'fix', name: 'fix', kind: 'branch', condition: { operator: 'not-equals', path: [], value: {} } }],
  ];
  for (const [previous, next] of steps) {
    const before = { ...definition(), steps: [previous], edges: [] };
    const after = { ...before, steps: [next] };
    assert.deepEqual(validateCompatibleDefinition(before, after, 'fix').definition, after);
  }
  const mcp: WorkflowStep = { id: 'fix', name: 'fix', kind: 'mcp', tool: { connectionId: 'connection', connectionName: 'Connection', identity: 'a'.repeat(64), serverIdentity: 'b'.repeat(64), toolName: 'tool', inputSchema: {}, outputSchema: {} } };
  const before = { ...definition(), steps: [mcp], edges: [] };
  const after = structuredClone(before);
  after.steps[0]!.timeoutMs = 50;
  validateCompatibleDefinition(before, after, 'fix');
  for (const field of ['connectionId', 'connectionName', 'identity', 'serverIdentity', 'toolName', 'inputSchema', 'outputSchema'] as const) {
    const changed = structuredClone(after);
    if (changed.steps[0]!.kind === 'mcp') Object.assign(changed.steps[0]!.tool, { [field]: field.endsWith('Schema') ? true : field.endsWith('dentity') ? 'c'.repeat(64) : 'other' });
    assert.throws(() => validateCompatibleDefinition(before, changed, 'fix'), field);
  }
});

it('validates optional correction audit shape, snapshot chain, compatibility and retry attempt references on reload', async () => {
  const scheduler = new WorkflowScheduler(store, { agent: { check() {}, async execute() { throw new Error('failed'); } } });
  const started = scheduler.start(definition(), session, {});
  const failed = await scheduler.wait(session.sessionId, started.id);
  // Root failed, so correct it rather than rewinding an unattempted dependent.
  const fixed = structuredClone(failed.definition);
  if (fixed.steps[0]!.kind === 'agent') fixed.steps[0]!.instructions = 'corrected';
  scheduler.recover(session, started.id, action(fixed, 'root'), fixed);
  const result = await scheduler.wait(session.sessionId, started.id);
  assert.deepEqual(parseExecution(result), result);
  const mutations: Array<(record: WorkflowExecution) => void> = [
    record => { record.definitionUpdates![0]!.stepId = 'unknown'; },
    record => { record.definitionUpdates![0]!.nextStep.name = 'mismatch'; },
    record => { record.definitionUpdates![0]!.previousStep.id = 'mismatch'; },
    record => { record.definitionUpdates![0]!.previousStep.mapping = { kind: 'reference', reference: { source: 'input', path: [] } }; },
    record => { record.definitionUpdates![0]!.attempt = 1; },
    record => { record.definitionUpdates![0]!.attempt = 4; },
    record => { record.definitionUpdates![0]!.appliedAt = -1; },
    record => { record.steps.root!.attempts[1]!.action = 'supply'; },
  ];
  for (const mutate of mutations) { const invalid = structuredClone(result); mutate(invalid); assert.throws(() => parseExecution(invalid)); }
  // A crash after the correction checkpoint, before pump appends its retry, is readable.
  const beforePump = structuredClone(result);
  beforePump.steps.root!.attempts.pop();
  beforePump.steps.root!.status = 'pending';
  delete beforePump.steps.root!.outcome;
  assert.deepEqual(parseExecution(beforePump), beforePump);
});
