import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowScheduler, type ExecutorContext } from '../src/workflows/scheduler.ts';
import { parseExecution } from '../src/workflows/records.ts';
import { WorkflowStore } from '../src/workflows/store.ts';
import { validateDefinition } from '../src/workflows/graph.ts';
import { parseValue } from '../src/workflows/schema.ts';
import type { WorkflowDefinition, WorkflowStep, VisualSchema, WorkflowEdge } from '../src/protocol/workflows.ts';
import { analyzeLoops } from '../src/workflows/loops.ts';

const edge = (from: string, to: string): WorkflowEdge => ({ id: `${from}-${to}`, from, to, outcome: 'success' });
const graph = (ids: string[], pairs: [string, string][]) => analyzeLoops({ steps: ids.map(id => ({ id })), edges: pairs.map(([from, to]) => edge(from, to)) });

const number: VisualSchema = { type: 'number' };
const step = (id: string, outputSchema: VisualSchema = number): WorkflowStep => ({ id, name: id, kind: 'typescript', code: 'return 1', outputSchema });
const loopDefinition = (): WorkflowDefinition => ({
  version: 1, id: 'loop', name: 'Loop', backend: 'fake', inputSchema: { type: 'object', fields: {} },
  steps: [step('root', { type: 'string' }), step('head'), { id: 'check', name: 'check', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } }, step('body'), step('exit')],
  edges: [edge('root', 'head'), edge('head', 'check'), { ...edge('check', 'body'), outcome: 'true' }, edge('body', 'head'), { ...edge('check', 'exit'), outcome: 'false' }],
});
const ref = (stepId: string) => ({ kind: 'reference' as const, reference: { source: 'step' as const, stepId, path: [] } });

describe('workflow loop definitions', () => {
  it('separates first and repeat inputs and preserves all edges', () => {
    const result = validateDefinition(loopDefinition());
    assert.equal(result.loops[0]!.maxTries, 3);
    assert.deepEqual(result.firstInputSchemas.get('head'), { type: 'string' });
    assert.deepEqual(result.repeatInputSchemas.get('head'), number);
    assert.equal(parseValue(result.inputSchemas.get('head')!, 'first'), 'first');
    assert.equal(parseValue(result.inputSchemas.get('head')!, 2), 2);
    assert.equal(result.incoming.get('head')!.length, 2);
    assert.deepEqual(result.order.map(step => step.id), ['root', 'head', 'check', 'body', 'exit']);
  });

  it('validates bounded settings and header-only repeat mappings', () => {
    const definition = loopDefinition();
    assert.equal(validateDefinition({ ...definition, loopSettings: { head: { maxTries: 1 } } }).loops[0]!.maxTries, 1);
    for (const maxTries of [0, -1, 1.5, 101]) assert.throws(() => validateDefinition({ ...definition, loopSettings: { head: { maxTries } } }));
    assert.throws(() => validateDefinition({ ...definition, loopSettings: { root: { maxTries: 3 } } }), /header/i);
    definition.steps[0]!.repeatMapping = ref('body');
    assert.throws(() => validateDefinition(definition), /header/i);
  });

  it('uses separate mappings and checks both against the declared input', () => {
    const definition = loopDefinition();
    definition.steps[1]!.mapping = ref('root');
    definition.steps[1]!.repeatMapping = ref('body');
    validateDefinition(definition);
    definition.steps[1]!.inputSchema = { type: 'string' };
    assert.throws(() => validateDefinition(definition), /does not match/);
    delete definition.steps[1]!.inputSchema;
    definition.steps[1]!.mapping = ref('body');
    assert.throws(() => validateDefinition(definition), /earlier/);
  });

  it('rejects stale body references on exit but accepts guaranteed header outputs', () => {
    const definition = loopDefinition();
    definition.steps[4]!.mapping = ref('body');
    assert.throws(() => validateDefinition(definition), /earlier|guaranteed/);
    definition.steps[4]!.mapping = ref('head');
    validateDefinition(definition);
  });

  it('rejects simultaneous exit and repeat selection', () => {
    const definition = loopDefinition();
    definition.edges.push(edge('head', 'exit'));
    assert.throws(() => validateDefinition(definition), /exit.*repeat|repeat.*exit/i);
  });

  it('checks previous outputs at every selected back edge', () => {
    const definition = loopDefinition();
    definition.steps.push(step('other'));
    definition.edges = definition.edges.filter(edge => edge.to !== 'exit');
    definition.edges.push({ ...edge('check', 'other'), outcome: 'false' }, edge('other', 'head'));
    definition.steps[1]!.repeatMapping = ref('body');
    assert.throws(() => validateDefinition(definition), /not guaranteed/);
    definition.steps[1]!.repeatMapping = ref('head');
    validateDefinition(definition);
    definition.steps[1]!.repeatMapping = ref('root');
    validateDefinition(definition);
  });

  it('does not let ordinary mappings read the previous iteration', () => {
    const definition = loopDefinition();
    definition.steps[2]!.mapping = ref('body');
    assert.throws(() => validateDefinition(definition), /earlier/);
  });

  it('does not require both entry and repeat fields on a Join header', () => {
    const definition = loopDefinition();
    definition.steps[1] = { id: 'head', name: 'head', kind: 'join' };
    definition.steps[2] = { id: 'check', name: 'check', kind: 'branch', condition: { operator: 'equals', path: [], value: {} } };
    const result = validateDefinition(definition);
    assert.deepEqual(parseValue(result.inputSchemas.get('head')!, { root: 'first' }), { root: 'first' });
    assert.deepEqual(parseValue(result.inputSchemas.get('head')!, { body: 2 }), { body: 2 });
    assert.throws(() => parseValue(result.inputSchemas.get('head')!, { root: 'first', body: 2 }));
    definition.steps[1]!.inputSchema = { type: 'object', fields: { root: { schema: { type: 'string' } }, body: { schema: number }, count: { schema: number, default: 3 } } };
    assert.equal((parseValue(validateDefinition(definition).repeatInputSchemas.get('head')!, { body: 2 }) as { count: number }).count, 3);
  });

  it('validates nested loop phases without unrolling limits', () => {
    const definition = loopDefinition();
    definition.steps.push(step('outer'), step('tail'));
    definition.edges[0] = edge('root', 'outer');
    definition.edges.push(edge('outer', 'head'), edge('exit', 'tail'), edge('tail', 'outer'));
    definition.loopSettings = { outer: { maxTries: 100 }, head: { maxTries: 100 } };
    const result = validateDefinition(definition);
    assert.deepEqual(result.loops.map(loop => [loop.headerId, loop.parentHeaderId]), [['outer', undefined], ['head', 'outer']]);
    assert.deepEqual(result.repeatInputSchemas.get('outer'), number);
    definition.steps[1]!.repeatMapping = ref('tail');
    assert.throws(() => validateDefinition(definition), /earlier|guaranteed/);
  });

  it('rejects conditional output references after rejoining loop exits', () => {
    const definition = loopDefinition();
    definition.steps.push(step('early'), { id: 'joined', name: 'joined', kind: 'join' }, step('consumer'));
    definition.edges.push({ ...edge('head', 'early'), outcome: 'failure' }, edge('early', 'joined'), edge('exit', 'joined'), edge('joined', 'consumer'));
    definition.steps.at(-1)!.mapping = ref('check');
    assert.throws(() => validateDefinition(definition), /not guaranteed/);
  });

  it('validates repeat mapping paths and optional direct references', () => {
    const definition = loopDefinition();
    definition.steps[3] = step('body', { type: 'object', fields: { value: { schema: number } } });
    definition.steps[1]!.repeatMapping = { kind: 'reference', reference: { source: 'step', stepId: 'body', path: ['value'] } };
    assert.throws(() => validateDefinition(definition), /required/);
    definition.steps[1]!.repeatMapping = { kind: 'reference', reference: { source: 'step', stepId: 'body', path: ['missing'] } };
    assert.throws(() => validateDefinition(definition), /Unknown field/);
  });

  it('uses declared outputs to break repeat mapping schema dependencies', () => {
    const definition = loopDefinition();
    definition.steps[3] = { id: 'body', name: 'body', kind: 'join' };
    definition.steps[1]!.repeatMapping = ref('body');
    const result = validateDefinition(definition);
    assert.deepEqual(parseValue(result.repeatInputSchemas.get('head')!, { check: true }), { check: true });
    definition.steps[1]!.inputSchema = number;
    assert.throws(() => validateDefinition(definition), /does not match/);
  });

  it('checks branch conditions against both header phases', () => {
    const definition = loopDefinition();
    definition.steps[0] = step('root');
    definition.steps[1] = { id: 'head', name: 'head', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } };
    definition.steps[2] = step('check');
    definition.steps[3] = step('body', { type: 'string' });
    definition.edges = [edge('root', 'head'), { ...edge('head', 'body'), outcome: 'true' }, edge('body', 'head'), { ...edge('head', 'exit'), outcome: 'false' }];
    assert.throws(() => validateDefinition(definition), /required number/);
  });

  it('requires an explicit schema to break recursive join inference', () => {
    const definition = loopDefinition();
    definition.steps[1] = { id: 'head', name: 'head', kind: 'join' };
    definition.steps[2] = step('check');
    definition.steps[3] = { id: 'body', name: 'body', kind: 'join' };
    definition.edges = [edge('root', 'head'), edge('head', 'body'), edge('body', 'head')];
    assert.throws(() => validateDefinition(definition), /cyclic.*schema|schema.*cycl/i);
  });
});

const session = { sessionId: 'session', scope: '/scope', backend: 'fake' };
const agentDefinition = () => {
  const definition = loopDefinition();
  definition.steps = definition.steps.map(step => step.kind === 'typescript' ? { id: step.id, name: step.name, kind: 'agent', instructions: step.id, model: 'fake', effort: 'off', outputSchema: step.outputSchema } : step);
  return definition;
};
const loopFixture = (execute: (context: ExecutorContext) => Promise<import('../src/protocol/workflows.ts').Json>) => {
  const root = mkdtempSync(join(tmpdir(), 'flow-loop-'));
  const store = new WorkflowStore(root);
  const executors = { agent: { check() {}, execute }, typescript: { check() {}, execute } };
  return { root, store, executors, scheduler: new WorkflowScheduler(store, executors), close() { rmSync(root, { recursive: true, force: true }); } };
};

describe('workflow loop execution', () => {
  it('keeps history readable and permits cancellation after failure before loop entry', async () => {
    const f = loopFixture(async () => { throw new Error('Entry failed'); });
    try {
      const started = f.scheduler.start(loopDefinition(), session, {});
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'recovery-required');
      assert.equal(result.loops!.head!.phase, 'inactive');
      assert.equal(result.steps.head!.status, 'blocked');
      assert.deepEqual(f.store.listExecutions(session.sessionId), [result]);
      const restarted = new WorkflowScheduler(f.store, f.executors);
      assert.equal(restarted.occupied(session.sessionId), true);
      await restarted.cancel(session.sessionId, started.id);
      assert.equal(f.store.getExecution(session.sessionId, started.id).status, 'cancelled');
      assert.equal(restarted.occupied(session.sessionId), false);
    } finally { f.close(); }
  });

  it('grants one try, scopes guidance to corrective and header Agents, and rejects stale grants', async () => {
    const seen: ExecutorContext[] = [];
    let checks = 0;
    const f = loopFixture(async context => {
      seen.push(context);
      if (context.step.id === 'root') return 'initial';
      if (context.step.id === 'head') return ++checks === 5 ? 0 : 1;
      return 1;
    });
    try {
      const definition = agentDefinition();
      const original = structuredClone(definition);
      const started = f.scheduler.start(definition, session, {});
      let result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.loops!.head!.phase, 'limit');
      const decision = { kind: 'extend-loop' as const, headerId: 'head', activation: 1, try: 3, guidance: 'Use the missing test' };
      assert.throws(() => f.scheduler.recover(session, started.id, { ...decision, activation: 2 }));
      assert.throws(() => f.scheduler.recover(session, started.id, { ...decision, guidance: 'x'.repeat(100_001) }));
      assert.equal(f.scheduler.get(session.sessionId, started.id).loops!.head!.grants.length, 0);
      f.scheduler.recover(session, started.id, decision);
      assert.throws(() => f.scheduler.recover(session, started.id, decision));
      result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.loops!.head!.try, 4);
      assert.equal(result.status, 'recovery-required');
      assert.throws(() => f.scheduler.recover(session, started.id, decision));
      f.scheduler.recover(session, started.id, { kind: 'extend-loop', headerId: 'head', activation: 1, try: 4 });
      result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'completed-with-recovery');
      assert.deepEqual(seen.filter(context => context.step.kind === 'agent' && context.step.instructions.includes('Use the missing test')).map(context => context.step.id), ['body', 'head']);
      assert.deepEqual(result.steps.head!.attempts.map(attempt => attempt.action), Array(5).fill('execute'));
      assert.deepEqual(result.steps.body!.attempts.map(attempt => attempt.loops![0]!.try), [2, 3, 4, 5]);
      assert.deepEqual(result.definition, original);
      assert.deepEqual(definition, original);
      assert.deepEqual(parseExecution(result), result);
    } finally { f.close(); }
  });

  it('retains a granted try and guidance across interrupted corrective work without replay', async () => {
    let checks = 0, interruptWorker = true;
    const seen: ExecutorContext[] = [];
    const f = loopFixture(async context => {
      seen.push(context);
      if (context.step.id === 'root') return 'initial';
      if (context.step.id === 'head') return ++checks === 4 ? 0 : 1;
      if (context.step.id === 'body' && checks === 3 && interruptWorker) return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
      return 1;
    });
    try {
      const started = f.scheduler.start(agentDefinition(), session, {});
      await f.scheduler.wait(session.sessionId, started.id);
      let restarted = new WorkflowScheduler(f.store, f.executors);
      assert.equal(restarted.get(session.sessionId, started.id).loops!.head!.phase, 'limit');
      assert.throws(() => restarted.recover(session, started.id, { kind: 'continue' }), /loop limit/i);
      restarted.recover(session, started.id, { kind: 'extend-loop', headerId: 'head', activation: 1, try: 3, guidance: 'Extra instructions' });
      await new Promise(resolve => setImmediate(resolve));
      await restarted.interrupt(session.sessionId, started.id);
      const count = seen.length;
      interruptWorker = false;
      restarted = new WorkflowScheduler(f.store, f.executors);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(seen.length, count);
      assert.throws(() => restarted.recover(session, started.id, { kind: 'continue' }), /interrupted/);
      restarted.recover(session, started.id, { kind: 'retry', stepId: 'body' });
      const result = await restarted.wait(session.sessionId, started.id);
      assert.equal(result.loops!.head!.try, 4);
      assert.equal(result.loops!.head!.grants.length, 1);
      assert.equal(result.status, 'completed-with-recovery');
      assert.deepEqual(result.steps.body!.attempts.slice(-2).map(attempt => [attempt.action, attempt.loops![0]!.try]), [['execute', 4], ['retry', 4]]);
      assert.deepEqual(seen.filter(context => context.step.kind === 'agent' && context.step.instructions.includes('Extra instructions')).map(context => context.step.id), ['body', 'body', 'head']);
    } finally { f.close(); }
  });

  it('uses first mapping only on entry and resolves repeat mapping before outputs reset', async () => {
    const inputs: unknown[] = [];
    let checks = 0;
    const f = loopFixture(async ({ step, input }) => {
      if (step.id === 'root') return 'initial';
      if (step.id === 'head') { inputs.push(input); return ++checks === 3 ? 0 : 1; }
      return 7;
    });
    try {
      const definition = loopDefinition();
      definition.steps[1]!.mapping = ref('root');
      definition.steps[1]!.repeatMapping = ref('head');
      const started = f.scheduler.start(definition, session, {});
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'completed');
      assert.deepEqual(inputs, ['initial', 1, 1]);
      assert.equal(result.loops!.head!.headerInput, 1);
    } finally { f.close(); }
  });

  it('counts an unconnected branch outcome as an exit', async () => {
    let checks = 0;
    const f = loopFixture(async ({ step }) => step.id === 'root' ? 'initial' : step.id === 'head' ? ++checks === 3 ? 0 : 1 : 1);
    try {
      const definition = loopDefinition();
      definition.steps = definition.steps.filter(step => step.id !== 'exit');
      definition.edges = definition.edges.filter(edge => edge.to !== 'exit');
      const started = f.scheduler.start(definition, session, {});
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'completed');
      assert.equal(result.result, false);
      assert.equal(result.steps.body!.attempts.length, 2);
    } finally { f.close(); }
  });

  for (const manual of [false, true]) it(`resets nested counts on outer repeat and scopes outer guidance: manual=${manual}`, async () => {
    let outer = 0, inner = 0;
    const seen: ExecutorContext[] = [];
    const f = loopFixture(async context => {
      seen.push(context);
      if (context.step.id === 'root') return 'initial';
      if (context.step.id === 'outer') return ++outer === 2 ? 0 : 1;
      if (context.step.id === 'head') return ++inner % 2;
      return 1;
    });
    try {
      const definition = agentDefinition();
      definition.steps.push({ ...definition.steps[1]!, id: 'outer', name: 'outer' }, { ...definition.steps[1]!, id: 'outerworker', name: 'outerworker' }, { id: 'outercheck', name: 'outercheck', kind: 'branch', mapping: ref('outer'), condition: { operator: 'greater-than', path: [], value: 0 } });
      definition.edges[0] = edge('root', 'outer');
      definition.edges = definition.edges.filter(edge => edge.to !== 'exit');
      definition.edges.push(edge('outer', 'head'), { ...edge('check', 'outercheck'), outcome: 'false' }, { ...edge('outercheck', 'outerworker'), outcome: 'true' }, edge('outerworker', 'outer'), { ...edge('outercheck', 'exit'), outcome: 'false' });
      definition.loopSettings = { outer: { maxTries: manual ? 1 : 2 }, head: { maxTries: 2 } };
      const started = f.scheduler.start(definition, session, {});
      let result = await f.scheduler.wait(session.sessionId, started.id);
      if (manual) {
        assert.equal(result.status, 'recovery-required');
        assert.equal(result.steps.outerworker!.attempts.length, 0);
        f.scheduler.recover(session, started.id, { kind: 'extend-loop', headerId: 'outer', activation: 1, try: 1, guidance: 'outer guidance' });
        result = await f.scheduler.wait(session.sessionId, started.id);
      }
      assert.equal(result.status, manual ? 'completed-with-recovery' : 'completed');
      assert.equal(result.loops!.head!.activation, 2);
      assert.deepEqual(result.steps.head!.attempts.map(attempt => attempt.loops!.map(identity => [identity.headerId, identity.activation, identity.try])), [
        [['outer', 1, 1], ['head', 1, 1]], [['outer', 1, 1], ['head', 1, 2]], [['outer', 1, 2], ['head', 2, 1]], [['outer', 1, 2], ['head', 2, 2]],
      ]);
      assert.deepEqual(seen.filter(context => context.step.kind === 'agent' && context.step.instructions.includes('outer guidance')).map(context => context.step.id), manual ? ['outerworker', 'outer', 'head', 'body', 'head'] : []);
      assert.deepEqual(parseExecution(result), result);
    } finally { f.close(); }
  });

  it('handles an outer back edge from a nested loop and an exit crossing both regions', async () => {
    let checks = 0;
    const f = loopFixture(async ({ step }) => step.id === 'root' ? 'initial' : step.id === 'outer' ? ++checks === 1 : 1);
    try {
      const definition: WorkflowDefinition = {
        ...loopDefinition(),
        steps: [step('root', { type: 'string' }), step('outer', { type: 'boolean' }), { id: 'head', name: 'head', kind: 'branch', condition: { operator: 'truthy', path: [] } }, { id: 'check', name: 'check', kind: 'branch', condition: { operator: 'equals', path: [], value: false } }, step('exit')],
        edges: [edge('root', 'outer'), edge('outer', 'head'), { ...edge('head', 'check'), outcome: 'true' }, { ...edge('head', 'exit'), outcome: 'false' }, { ...edge('check', 'head'), outcome: 'true' }, { ...edge('check', 'outer'), outcome: 'false' }],
        loopSettings: { outer: { maxTries: 2 } },
      };
      const started = f.scheduler.start(definition, session, {});
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'completed');
      assert.equal(checks, 2);
      assert.equal(result.loops!.outer!.phase, 'exited');
      assert.equal(result.loops!.head!.phase, 'exited');
      assert.equal(result.loops!.head!.activation, 2);
      assert.equal(result.steps.exit!.attempts.length, 1);
    } finally { f.close(); }
  });

  it('drains parallel back edges before reset and holds exit consumers until the final check', async () => {
    let release!: () => void;
    let checks = 0;
    const f = loopFixture(async ({ step }) => {
      if (step.id === 'root') return 'initial';
      if (step.id === 'head') return ++checks === 2 ? 0 : 1;
      if (step.id === 'slow') await new Promise<void>(resolve => { release = resolve; });
      return 1;
    });
    try {
      const definition = loopDefinition();
      definition.steps.push(step('slow'));
      definition.edges.push({ ...edge('check', 'slow'), outcome: 'true' }, edge('slow', 'head'));
      const started = f.scheduler.start(definition, session, {});
      await new Promise(resolve => setImmediate(resolve));
      const waiting = f.scheduler.get(session.sessionId, started.id);
      assert.equal(waiting.steps.slow!.status, 'running');
      assert.equal(waiting.steps.body!.status, 'completed');
      assert.equal(waiting.steps.exit!.status, 'pending');
      assert.equal(checks, 1);
      release();
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'completed');
      assert.equal(checks, 2);
      assert.equal(result.steps.exit!.attempts.length, 1);
    } finally { f.close(); }
  });

  for (const exits of [true, false]) it(`rechecks a skipped handler after timeout recovery without replaying an exited loop: exits=${exits}`, async () => {
    let workers = 0, checks = 0;
    const seen: string[] = [];
    const f = loopFixture(async ({ step, signal }) => {
      seen.push(step.id);
      if (step.id === 'root') return 'initial';
      if (step.id === 'head') return ++checks === 2 && exits ? 0 : 1;
      if (step.id === 'prior') return 0;
      if (step.id === 'body') {
        if (!workers++) return new Promise(resolve => signal.addEventListener('abort', () => resolve(1), { once: true }));
        throw new Error('worker failed');
      }
      return 7;
    });
    try {
      const definition = loopDefinition();
      definition.steps.push(step('handler'), step('prior'), { id: 'priorcheck', name: 'priorcheck', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } }, step('priorbody'));
      definition.steps[3]!.timeoutMs = 5;
      definition.edges[0] = edge('root', 'prior');
      definition.edges.push(edge('prior', 'priorcheck'), { ...edge('priorcheck', 'priorbody'), outcome: 'true' }, edge('priorbody', 'prior'), { ...edge('priorcheck', 'head'), outcome: 'false' }, { ...edge('body', 'handler'), outcome: 'failure' }, edge('handler', 'head'));
      definition.loopSettings = { head: { maxTries: 2 } };
      const started = f.scheduler.start(definition, session, {});
      const before = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(before.status, 'recovery-required');
      assert.equal(before.steps.body!.status, 'timed-out');
      assert.equal(before.steps.handler!.status, 'skipped');
      assert.equal(before.loops!.prior!.phase, 'exited');
      assert.equal(f.scheduler.occupied(session.sessionId), true);
      f.scheduler.recover(session, started.id, { kind: 'retry', stepId: 'body' });
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.deepEqual(seen, ['root', 'prior', 'head', 'body', 'body', 'handler', 'head', ...(exits ? ['exit'] : [])]);
      assert.equal(result.status, exits ? 'completed-with-recovery' : 'recovery-required');
      assert.equal(result.loops!.head!.phase, exits ? 'exited' : 'limit');
      assert.equal(result.steps.check!.attempts.length, 2);
      assert.equal(result.steps.handler!.attempts.length, 1);
      assert.deepEqual(result.steps.handler!.attempts[0]!.loops, [{ headerId: 'head', activation: 1, try: 2 }]);
      for (const id of ['root', 'prior', 'priorcheck', 'priorbody']) assert.deepEqual(result.steps[id], before.steps[id]);
      assert.deepEqual(result.loops!.prior, before.loops!.prior);
      assert.equal(f.scheduler.occupied(session.sessionId), !exits);
      if (exits) assert.equal(result.result, 7);
      assert.deepEqual(parseExecution(result), result);
    } finally { f.close(); }
  });

  for (const previouslyEntered of [false, true]) it(`reactivates skipped nested handlers after timeout recovery: previouslyEntered=${previouslyEntered}`, async () => {
    let workers = 0, checks = 0;
    const seen: string[] = [];
    const f = loopFixture(async ({ step, signal }) => {
      seen.push(step.id);
      if (step.id === 'root') return 'initial';
      if (step.id === 'head') return ++checks === (previouslyEntered ? 3 : 2) ? 0 : 1;
      if (step.id === 'route') return checks === 1 ? 0 : 1;
      if (step.id === 'body') {
        if (!workers++) return new Promise(resolve => signal.addEventListener('abort', () => resolve(1), { once: true }));
        throw new Error('worker failed');
      }
      return 0;
    });
    try {
      const definition = loopDefinition();
      for (const id of ['handler', 'inner']) {
        definition.steps.push(step(id), { id: `${id}check`, name: `${id}check`, kind: 'branch', mapping: ref(id), condition: { operator: 'greater-than', path: [], value: 0 } }, step(`${id}body`));
        definition.edges.push({ ...edge(`${id}check`, `${id}body`), outcome: 'true' }, edge(`${id}body`, id));
      }
      definition.steps[3]!.timeoutMs = 5;
      if (previouslyEntered) {
        definition.steps.push(step('route'), { id: 'routecheck', name: 'routecheck', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } });
        definition.edges = definition.edges.filter(edge => edge.id !== 'check-body');
        definition.edges.push({ ...edge('check', 'route'), outcome: 'true' }, edge('route', 'routecheck'), { ...edge('routecheck', 'body'), outcome: 'true' }, { ...edge('routecheck', 'handler'), outcome: 'false' });
      }
      definition.edges.push({ ...edge('body', 'handler'), id: 'body-handler-failure', outcome: 'failure' }, edge('handler', 'inner'), edge('inner', 'innercheck'), { ...edge('innercheck', 'handlercheck'), outcome: 'false' }, { ...edge('handlercheck', 'head'), outcome: 'false' });
      const started = f.scheduler.start(definition, session, {});
      const before = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(before.status, 'recovery-required');
      assert.equal(before.steps.body!.status, 'timed-out');
      for (const id of ['handler', 'inner']) {
        assert.equal(before.steps[id]!.status, 'skipped');
        assert.equal(before.loops![id]!.phase, 'exited');
        assert.equal(before.loops![id]!.activation, previouslyEntered ? 1 : 0);
        assert.equal(before.loops![id]!.try, 0);
      }
      const count = seen.length;
      f.scheduler.recover(session, started.id, { kind: 'retry', stepId: 'body' });
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.deepEqual(seen.slice(count), ['body', 'handler', 'inner', 'head', 'exit']);
      assert.equal(result.status, 'completed-with-recovery');
      assert.equal(result.result, 0);
      assert.equal(result.steps.check!.attempts.length, previouslyEntered ? 3 : 2);
      for (const id of ['handler', 'inner']) {
        const attempts = result.steps[id]!.attempts;
        assert.equal(attempts.length, previouslyEntered ? 2 : 1);
        assert.equal(attempts.at(-1)!.action, 'execute');
        assert.deepEqual(attempts.at(-1)!.loops!.find(loop => loop.headerId === id), { headerId: id, activation: previouslyEntered ? 2 : 1, try: 1 });
        assert.equal(result.steps[`${id}body`]!.attempts.length, 0);
      }
      assert.deepEqual(result.steps.root, before.steps.root);
      assert.deepEqual(parseExecution(result), result);
    } finally { f.close(); }
  });

  it('does not reset a failed parallel member when another back edge is selected', async () => {
    let checks = 0, failures = 0;
    const f = loopFixture(async ({ step }) => {
      if (step.id === 'root') return 'initial';
      if (step.id === 'head') return ++checks === 2 ? 0 : 1;
      if (step.id === 'other' && !failures++) throw new Error('failed corrective work');
      return 1;
    });
    try {
      const definition = loopDefinition();
      definition.steps.push(step('other'));
      definition.edges.push({ ...edge('check', 'other'), outcome: 'true' }, edge('other', 'head'));
      const started = f.scheduler.start(definition, session, {});
      let result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'recovery-required');
      assert.equal(checks, 1);
      assert.equal(result.steps.other!.status, 'failed');
      f.scheduler.recover(session, started.id, { kind: 'retry', stepId: 'other' });
      result = await f.scheduler.wait(session.sessionId, started.id);
      assert.equal(result.status, 'completed-with-recovery');
      assert.equal(result.steps.body!.attempts.length, 1);
      assert.deepEqual(result.steps.other!.attempts.map(attempt => [attempt.action, attempt.loops![0]!.try]), [['execute', 2], ['retry', 2]]);
    } finally { f.close(); }
  });

  it('rejects invalid persisted limits, grants, attempt identities and unfinished success', async () => {
    const f = loopFixture(async ({ step }) => step.id === 'root' ? 'initial' : 1);
    try {
      const started = f.scheduler.start(loopDefinition(), session, {});
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.deepEqual(parseExecution(result), result);
      const invalid = [
        (record: typeof result) => { delete record.loops; },
        (record: typeof result) => { record.loops!.head!.try = 4; },
        (record: typeof result) => { record.loops!.head!.try = 2; },
        (record: typeof result) => { record.loops!.head!.grants.push({ activation: 1, try: 4 }); },
        (record: typeof result) => { record.steps.head!.attempts[1]!.loops![0]!.activation = 2; },
        (record: typeof result) => { record.steps.head!.attempts[1]!.action = 'retry'; },
        (record: typeof result) => { record.status = 'completed'; },
      ];
      for (const mutate of invalid) { const record = structuredClone(result); mutate(record); assert.throws(() => parseExecution(record)); }
      await f.scheduler.cancel(session.sessionId, started.id);
    } finally { f.close(); }
  });

  it('does not execute a repeated header when its transition cannot be saved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-loop-storage-'));
    let checks = 0;
    class FailingStore extends WorkflowStore {
      override saveExecution(record: import('../src/protocol/workflows.ts').WorkflowExecution): void {
        if (record.steps.head!.attempts.length === 2) throw new Error('transition write failed');
        super.saveExecution(record);
      }
    }
    try {
      const store = new FailingStore(root);
      const scheduler = new WorkflowScheduler(store, { typescript: { check() {}, async execute({ step }) {
        if (step.id === 'root') return 'initial';
        if (step.id === 'head') checks++;
        return 1;
      } } });
      const started = scheduler.start(loopDefinition(), session, {});
      await assert.rejects(scheduler.wait(session.sessionId, started.id), /transition write failed/);
      assert.equal(checks, 1);
      assert.equal(scheduler.occupied(session.sessionId), true);
      const saved = store.getExecution(session.sessionId, started.id);
      assert.equal(saved.steps.head!.attempts.length, 1);
      assert.equal(saved.loops!.head!.phase, 'repeating');
      let replayed = false;
      new WorkflowScheduler(store, { typescript: { check() {}, async execute() { replayed = true; return 1; } } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(replayed, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects simultaneous implicit exit and repeat', () => {
    const definition = loopDefinition();
    definition.steps.push({ id: 'terminal', name: 'terminal', kind: 'branch', condition: { operator: 'greater-than', path: [], value: 0 } });
    definition.edges.push(edge('head', 'terminal'), { ...edge('terminal', 'body'), outcome: 'true' });
    assert.throws(() => validateDefinition(definition), /exit.*repeat/);
  });

  it('does not traverse a loop in an isolated step test', async () => {
    const seen: string[] = [];
    const f = loopFixture(async ({ step }) => { seen.push(step.id); return 1; });
    try {
      const started = f.scheduler.start(loopDefinition(), session, 2, 'head');
      const result = await f.scheduler.wait(session.sessionId, started.id);
      assert.deepEqual(seen, ['head']);
      assert.equal(result.loops, undefined);
      assert.equal(result.status, 'completed');
    } finally { f.close(); }
  });
  for (const succeeds of [true, false]) it(`bounds checks before corrective work: success=${succeeds}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-loop-'));
    try {
      let checks = 0, workers = 0;
      const workflow = loopDefinition();
      const scheduler = new WorkflowScheduler(new WorkflowStore(root), { typescript: {
        check() {}, async execute({ step }) {
          if (step.id === 'root') return 'initial';
          if (step.id === 'head') return ++checks === 3 && succeeds ? 0 : 1;
          if (step.id === 'body') workers++;
          return 1;
        },
      } });
      const session = { sessionId: 'session', scope: root, backend: 'fake' };
      const started = scheduler.start(workflow, session, {});
      const result = await scheduler.wait(session.sessionId, started.id);
      assert.equal(checks, 3);
      assert.equal(workers, 2);
      assert.equal(result.status, succeeds ? 'completed' : 'recovery-required');
      assert.equal(result.steps.exit!.status, succeeds ? 'completed' : 'pending');
      if (!succeeds) {
        assert.throws(() => scheduler.recover(session, started.id, { kind: 'continue' }), /loop limit/i);
        await scheduler.cancel(session.sessionId, started.id);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('workflow loop topology', () => {
  it('analyzes an 800-step reverse-order chain within two seconds', () => {
    const ids = Array.from({ length: 800 }, (_, index) => `step${index}`);
    const pairs: [string, string][] = ids.slice(1).map((id, index) => [ids[index]!, id]);
    const started = performance.now();
    const topology = graph([...ids].reverse(), pairs);
    assert.ok(performance.now() - started < 2000);
    assert.deepEqual(topology, { loops: [], order: ids });
  });

  it('keeps a DAG unchanged', () => {
    const topology = graph(['root', 'a', 'b', 'join'], [['root', 'a'], ['root', 'b'], ['a', 'join'], ['b', 'join']]);
    assert.deepEqual(topology.order, ['root', 'a', 'b', 'join']);
    assert.deepEqual(topology.loops, []);
  });

  it('finds the review loop without including first-entry work', () => {
    const topology = graph(['reader', 'implementer', 'reviewer', 'branch', 'worker', 'exit'], [
      ['reader', 'implementer'], ['implementer', 'reviewer'], ['reviewer', 'branch'],
      ['branch', 'worker'], ['worker', 'reviewer'], ['branch', 'exit'],
    ]);
    assert.deepEqual(topology.loops, [{
      headerId: 'reviewer', memberIds: ['reviewer', 'branch', 'worker'],
      backEdgeIds: ['worker-reviewer'], entryEdgeIds: ['implementer-reviewer'], exitEdgeIds: ['branch-exit'],
    }]);
    assert.deepEqual(topology.order, ['reader', 'implementer', 'reviewer', 'branch', 'worker', 'exit']);
  });

  it('merges back edges with the same header', () => {
    const topology = graph(['root', 'head', 'a', 'b'], [['root', 'head'], ['head', 'a'], ['head', 'b'], ['a', 'head'], ['b', 'head']]);
    assert.equal(topology.loops.length, 1);
    assert.deepEqual(topology.loops[0]!.backEdgeIds, ['a-head', 'b-head']);
    assert.deepEqual(topology.loops[0]!.memberIds, ['head', 'a', 'b']);
  });

  it('orders nested loops before their children', () => {
    const topology = graph(['root', 'outer', 'inner', 'check', 'after'], [
      ['root', 'outer'], ['outer', 'inner'], ['inner', 'check'], ['check', 'inner'], ['check', 'after'], ['after', 'outer'],
    ]);
    assert.deepEqual(topology.loops.map(loop => [loop.headerId, loop.parentHeaderId]), [['outer', undefined], ['inner', 'outer']]);
    assert.deepEqual(topology.loops[1]!.memberIds, ['inner', 'check']);
  });

  it('supports a self edge only when the header has an external entry', () => {
    assert.deepEqual(graph(['root', 'head'], [['root', 'head'], ['head', 'head']]).loops[0]!.memberIds, ['head']);
    assert.throws(() => graph(['head'], [['head', 'head']]), /root|entry/i);
  });

  it('rejects rootless components even beside a valid root', () => {
    assert.throws(() => graph(['root', 'a', 'b'], [['a', 'b'], ['b', 'a']]), /root|entry/i);
  });

  it('rejects multiple-entry and irreducible cycles', () => {
    assert.throws(() => graph(['root', 'a', 'b'], [['root', 'a'], ['root', 'b'], ['a', 'b'], ['b', 'a']]), /multiple.entry|irreducible/i);
    assert.throws(() => graph(['root', 'a', 'b', 'c'], [['root', 'a'], ['a', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'b'], ['c', 'a']]), /multiple.entry|irreducible|overlap/i);
  });

  it('does not inspect step mappings or schemas', () => {
    const definition = { steps: [{ id: 'root', mapping: 'invalid' }, { id: 'head', inputSchema: 'invalid' }], edges: [edge('root', 'head'), edge('head', 'head')] };
    const topology = analyzeLoops(definition);
    assert.equal(topology.loops[0]!.headerId, 'head');
  });

  it('rejects invalid graph identities before analysis', () => {
    assert.throws(() => graph(['a', 'a'], []), /unique/i);
    assert.throws(() => graph(['a'], [['a', 'missing']]), /endpoint/i);
    assert.throws(() => graph(['a', 'b'], [['a', 'b'], ['a', 'b']]), /unique/i);
  });
});
