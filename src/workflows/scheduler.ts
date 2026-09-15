import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json, StepAttempt, WorkflowDefinition, WorkflowEdge, WorkflowExecution, WorkflowPermission, WorkflowStep } from '../protocol/workflows.ts';
import type { RecoverWorkflow } from '../protocol/workflow-executions.ts';
import { resolveMapping, validateDefinition } from './graph.ts';
import type { WorkflowGraph } from './graph.ts';
import { declaredOutputSchema, parseValue, valueAt } from './schema.ts';
import { WorkflowStore } from './store.ts';

export interface WorkflowSession {
  sessionId: string;
  backend: string;
  scope: string;
  projectId?: string;
}
export interface ExecutorContext {
  sessionId: string;
  scope: string;
  executionId: string;
  step: WorkflowStep;
  input: Json;
  inputSchema?: import('../protocol/workflows.ts').VisualSchema;
  permission: WorkflowPermission;
  signal: AbortSignal;
}
export interface WorkflowExecutor {
  check(step: WorkflowStep, session: WorkflowSession): void;
  execute(context: ExecutorContext): Promise<Json>;
}
export interface WorkflowExecutors {
  agent?: WorkflowExecutor;
  shell?: WorkflowExecutor;
  typescript?: WorkflowExecutor;
}
export class WorkflowStepError extends Error {
  readonly partialOutput: Json | undefined;
  constructor(message: string, partialOutput?: Json) { super(message); this.partialOutput = partialOutput; }
}
interface ActiveExecution {
  record: WorkflowExecution;
  graph: WorkflowGraph;
  running: Map<string, { controller: AbortController; done: Promise<void> }>;
  waiters: Array<{ resolve: (record: WorkflowExecution) => void; reject: (error: unknown) => void }>;
  stopped: boolean;
  persistenceError?: unknown;
}

export class WorkflowLoopConflict extends Error {}

type EdgeState = 'waiting' | 'selected' | 'skipped' | 'blocked';
const occupied = (record: WorkflowExecution) => record.status === 'running' || record.status === 'recovery-required';

export class WorkflowScheduler {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly slots = new Map<string, string>();

  private readonly store: WorkflowStore;
  private readonly executors: WorkflowExecutors;

  constructor(store: WorkflowStore, executors: WorkflowExecutors) {
    this.store = store;
    this.executors = executors;
    for (const sessionId of store.listSessionIds()) {
      for (const record of store.listExecutions(sessionId)) {
        if (!occupied(record)) continue;
        if (this.slots.has(sessionId)) throw new Error('Multiple workflow executions occupy one Agent Session');
        if (record.status === 'running') {
          for (const step of Object.values(record.steps)) {
            if (step.status !== 'running') continue;
            step.status = 'interrupted';
            const attempt = step.attempts.at(-1)!;
            attempt.error = { kind: 'interrupted', message: 'Execution was interrupted; effects may already have occurred' };
            attempt.finishedAt = Date.now();
          }
          record.status = 'recovery-required';
          store.saveExecution(record);
        }
        this.install(record);
      }
    }
  }

  occupied(sessionId: string): boolean { return this.slots.has(sessionId); }

  forgetSession(sessionId: string): void {
    const executions = [...this.active.values()].filter(active => active.record.sessionId === sessionId);
    if (executions.some(active => active.running.size || active.record.status === 'running')) throw new Error('Workflow work must stop before forgetting an Agent Session');
    for (const active of executions) this.active.delete(active.record.id);
    this.slots.delete(sessionId);
  }

  start(definition: WorkflowDefinition, session: WorkflowSession, input: unknown, testStepId?: string): WorkflowExecution {
    if (this.occupied(session.sessionId)) throw new Error('Agent Session workflow slot is occupied');
    const graph = validateDefinition(definition);
    if (graph.definition.backend !== session.backend) throw new Error('Backend Adapter mismatch');
    if (graph.definition.projectId && graph.definition.projectId !== session.projectId) throw new Error('Workflow is restricted to another Project');
    const testStep = testStepId === undefined ? undefined : graph.order.find(step => step.id === testStepId);
    if (testStepId !== undefined && !testStep) throw new Error('Unknown test step');
    this.check(testStep ? [testStep] : graph.order, session);
    const parsed = parseValue(testStep ? graph.inputSchemas.get(testStep.id)! : graph.definition.inputSchema, input);
    const record: WorkflowExecution = {
      version: 1, id: randomUUID(), sessionId: session.sessionId, scope: session.scope,
      definition: graph.definition, input: parsed, status: 'running', startedAt: Date.now(),
      steps: Object.fromEntries(graph.order.map(step => [step.id, { status: testStep && step.id !== testStep.id ? 'skipped' : 'pending', attempts: [] }])),
      ...(testStepId === undefined ? { loops: Object.fromEntries(graph.loops.map(loop => [loop.headerId, { activation: 0, try: 0, phase: 'inactive', grants: [] }])) } : { testStepId }),
    };
    this.store.saveExecution(record);
    const active = this.install(record);
    this.pump(active);
    return structuredClone(record);
  }

  get(sessionId: string, executionId: string): WorkflowExecution {
    const active = this.active.get(executionId);
    if (active?.record.sessionId === sessionId) return structuredClone(active.record);
    return this.store.getExecution(sessionId, executionId);
  }

  wait(sessionId: string, executionId: string): Promise<WorkflowExecution> {
    const active = this.require(sessionId, executionId);
    if (active.persistenceError) return Promise.reject(active.persistenceError);
    if (active.record.status !== 'running' && !active.running.size) return Promise.resolve(structuredClone(active.record));
    return new Promise((resolve, reject) => active.waiters.push({ resolve, reject }));
  }

  async cancel(sessionId: string, executionId: string): Promise<WorkflowExecution> {
    const active = this.require(sessionId, executionId);
    if (!occupied(active.record)) return structuredClone(active.record);
    active.stopped = true;
    active.record.status = 'cancelled';
    for (const step of Object.values(active.record.steps)) if (['pending', 'blocked', 'running', 'interrupted'].includes(step.status)) step.status = 'cancelled';
    this.persist(active);
    for (const running of active.running.values()) running.controller.abort();
    await Promise.all([...active.running.values()].map(running => running.done));
    active.record.finishedAt = Date.now();
    this.persist(active);
    this.settle(active);
    return structuredClone(active.record);
  }

  async interrupt(sessionId: string, executionId: string): Promise<WorkflowExecution> {
    const active = this.require(sessionId, executionId);
    if (!occupied(active.record)) return structuredClone(active.record);
    active.stopped = true;
    active.record.status = 'recovery-required';
    for (const step of Object.values(active.record.steps)) {
      if (step.status !== 'running') continue;
      step.status = 'interrupted';
      const attempt = step.attempts.at(-1)!;
      attempt.error = { kind: 'interrupted', message: 'Execution was interrupted; effects may already have occurred' };
      attempt.finishedAt = Date.now();
    }
    this.persist(active);
    for (const running of active.running.values()) running.controller.abort();
    await Promise.all([...active.running.values()].map(running => running.done));
    this.settle(active);
    return structuredClone(active.record);
  }

  recover(session: WorkflowSession, executionId: string, action: RecoverWorkflow): WorkflowExecution {
    const active = this.require(session.sessionId, executionId);
    const record = active.record;
    if (record.status !== 'recovery-required' || active.running.size) throw new Error('Execution is not ready for recovery');
    if (record.definition.backend !== session.backend || record.scope !== session.scope) throw new Error('Recovery requires the original Scope and Backend Adapter');
    this.check(active.graph.order.filter(step => (!record.testStepId || step.id === record.testStepId) && record.steps[step.id]!.status !== 'completed' && !(action.kind === 'supply' && step.id === action.stepId)), session);
    const limits = Object.entries(record.loops ?? {}).filter(([, loop]) => loop.phase === 'limit');
    if (action.kind === 'continue' && limits.length) throw new WorkflowLoopConflict('Loop limit requires an extra try or cancellation');
    if (action.kind === 'extend-loop') {
      const loop = record.loops?.[action.headerId];
      if (!loop || loop.phase !== 'limit' || loop.activation !== action.activation || loop.try !== action.try || loop.grants.some(grant => grant.activation === action.activation && grant.try === action.try + 1)) throw new WorkflowLoopConflict('Loop limit decision is no longer available');
      if (action.guidance !== undefined && (typeof action.guidance !== 'string' || action.guidance.length > 100_000)) throw new Error('Invalid loop guidance');
      loop.grants.push({ activation: loop.activation, try: loop.try + 1, ...(action.guidance === undefined ? {} : { guidance: action.guidance }) });
      loop.phase = 'active';
    } else if (action.kind !== 'continue') {
      const step = active.graph.order.find(step => step.id === action.stepId);
      const state = record.steps[action.stepId];
      if (!step || !state || !['interrupted', 'failed', 'timed-out'].includes(state.status)) throw new Error('Step does not require recovery');
      if (state.status !== 'interrupted' && !record.testStepId && !state.recovery && active.graph.outgoing.get(step.id)!.some(edge => edge.outcome === state.outcome)) throw new Error('Recover the failed handling step, not the handled failure');
      if (action.kind === 'supply') {
        const output = this.validateOutput(active, step, action.output);
        const attempt: StepAttempt = { number: state.attempts.length + 1, action: 'supply', startedAt: Date.now(), finishedAt: Date.now(), input: state.attempts.at(-1)!.input, output, ...(state.attempts.at(-1)!.loops ? { loops: structuredClone(state.attempts.at(-1)!.loops) } : {}) };
        state.attempts.push(attempt);
        state.output = output;
        state.status = 'completed';
        state.outcome = step.kind === 'branch' ? output ? 'true' : 'false' : 'success';
      } else {
        this.check([step], session);
        state.status = 'pending';
        delete state.outcome;
      }
      if (!record.testStepId) {
        const affected = new Set([step.id]);
        for (const downstream of active.graph.order) {
          const next = record.steps[downstream.id]!;
          if (!['pending', 'blocked', 'skipped'].includes(next.status) || !active.graph.forwardIncoming.get(downstream.id)!.some(edge => affected.has(edge.from))) continue;
          const exited = active.graph.loops.filter(loop => loop.memberIds.includes(downstream.id)).map(loop => record.loops![loop.headerId]!).filter(loop => loop.phase === 'exited');
          if (exited.some(loop => loop.try > 0)) continue;
          for (const loop of exited) loop.phase = 'inactive';
          affected.add(downstream.id);
          next.status = 'pending';
        }
      }
    } else if (Object.values(record.steps).some(step => ['interrupted', 'failed', 'timed-out'].includes(step.status) && !step.outcome)) throw new Error('Recover interrupted steps first');
    for (const step of Object.values(record.steps)) if (step.status === 'blocked' || (step.status === 'skipped' && !record.testStepId && !active.graph.loops.length)) step.status = 'pending';
    record.status = 'running';
    delete record.finishedAt;
    active.stopped = false;
    delete active.persistenceError;
    this.persist(active);
    this.pump(active);
    return structuredClone(record);
  }

  private check(steps: WorkflowStep[], session: WorkflowSession): void {
    for (const step of steps) {
      if (step.kind === 'branch' || step.kind === 'join') continue;
      const executor = this.executors[step.kind];
      if (!executor) throw new Error(`Executor is unavailable: ${step.kind}`);
      executor.check(step, session);
    }
  }

  private install(record: WorkflowExecution): ActiveExecution {
    const active: ActiveExecution = { record, graph: validateDefinition(record.definition), running: new Map(), waiters: [], stopped: record.status !== 'running' };
    this.active.set(record.id, active);
    this.slots.set(record.sessionId, record.id);
    return active;
  }

  private require(sessionId: string, executionId: string): ActiveExecution {
    const active = this.active.get(executionId);
    if (!active || active.record.sessionId !== sessionId) throw new Error('Unknown workflow execution');
    return active;
  }

  private edgeState(active: ActiveExecution, edge: WorkflowEdge): EdgeState {
    if (!active.record.testStepId && active.graph.loops.some(loop => loop.exitEdgeIds.includes(edge.id) && active.record.loops?.[loop.headerId]?.phase !== 'exited')) return 'waiting';
    const state = active.record.steps[edge.from]!;
    if (state.status === 'pending' || state.status === 'running') return 'waiting';
    if (state.status === 'skipped' || state.status === 'cancelled') return 'skipped';
    if (state.status === 'blocked' || state.status === 'interrupted') return 'blocked';
    if (state.outcome === edge.outcome && !(state.recovery && state.status !== 'completed')) return 'selected';
    if (state.status === 'completed') return 'skipped';
    const handled = !state.recovery && active.graph.outgoing.get(edge.from)!.some(candidate => candidate.outcome === state.outcome);
    return handled || edge.outcome === 'failure' || edge.outcome === 'timeout' ? 'skipped' : 'blocked';
  }

  private pump(active: ActiveExecution): void {
    if (active.stopped || active.record.status !== 'running') return;
    this.transitionLoops(active);
    for (const step of active.graph.order) {
      const state = active.record.steps[step.id]!;
      if (state.status !== 'pending') continue;
      if (active.graph.loops.some(loop => loop.memberIds.includes(step.id) && active.record.loops?.[loop.headerId]?.phase === 'limit')) continue;
      const header = active.record.loops?.[step.id];
      const edges = active.record.testStepId || (header && header.phase === 'active' && header.try > 1) ? [] : active.graph.forwardIncoming.get(step.id)!;
      const statuses = edges.map(edge => this.edgeState(active, edge));
      if (statuses.includes('waiting')) continue;
      if (statuses.includes('blocked')) { state.status = 'blocked'; continue; }
      if (edges.length && !statuses.includes('selected')) { state.status = 'skipped'; continue; }
      const selected = edges.filter((_, index) => statuses[index] === 'selected');
      if (!active.record.testStepId) {
        let limited = false;
        for (const loop of active.graph.loops) {
          const runtime = active.record.loops![loop.headerId]!;
          if (runtime.phase === 'active' && loop.memberIds.includes(step.id) && step.id !== loop.headerId && active.record.steps[loop.headerId]!.status === 'completed' && this.repeatOnly(active, loop, step.id)) {
            if (!this.reserveTry(active, loop)) limited = true;
          }
        }
        if (limited) continue;
        if (header?.phase === 'inactive') { header.activation++; header.try = 1; header.phase = 'active'; delete header.headerInput; }
      }
      state.recovery = !!header?.headerRecovery || selected.some(edge => edge.outcome === 'failure' || edge.outcome === 'timeout' || active.record.steps[edge.from]!.recovery);
      const controller = new AbortController();
      const identities = active.graph.loops.filter(loop => !active.record.testStepId && loop.memberIds.includes(step.id)).map(loop => ({ headerId: loop.headerId, activation: active.record.loops![loop.headerId]!.activation, try: active.record.loops![loop.headerId]!.try }));
      const previous = state.attempts.at(-1);
      const retry = previous && isDeepStrictEqual(previous.loops ?? [], identities);
      state.attempts.push({ number: state.attempts.length + 1, action: retry ? 'retry' : 'execute', startedAt: Date.now(), input: retry ? previous.input : header?.headerInput !== undefined ? header.headerInput : this.input(active, step, selected), ...(identities.length ? { loops: identities } : {}) });
      const done = Promise.resolve().then(() => this.execute(active, step, controller)).finally(() => {
        active.running.delete(step.id);
        if (active.stopped) {
          if (!active.running.size && active.persistenceError) this.settle(active);
          return;
        }
        this.pump(active);
      }).catch(error => {
        active.persistenceError = error;
        active.stopped = true;
        if (!active.running.size) this.settle(active);
      });
      state.status = 'running';
      active.running.set(step.id, { controller, done });
    }
    this.persist(active);
    if (active.running.size) return;
    if (this.transitionLoops(active)) { this.persist(active); this.pump(active); return; }
    const states = Object.entries(active.record.steps);
    const unresolved = Object.values(active.record.loops ?? {}).some(loop => loop.phase === 'limit') || states.some(([id, state]) => ['pending', 'interrupted', 'blocked'].includes(state.status) || ((state.status === 'failed' || state.status === 'timed-out') && (active.record.testStepId || state.recovery || !active.graph.outgoing.get(id)!.some(edge => edge.outcome === state.outcome))));
    if (unresolved) active.record.status = 'recovery-required';
    else {
      const terminals = active.graph.order.filter(step => active.record.steps[step.id]!.status === 'completed' && (active.record.testStepId || !active.graph.outgoing.get(step.id)!.some(edge => this.edgeState(active, edge) === 'selected')));
      active.record.result = terminals.length === 1 ? active.record.steps[terminals[0]!.id]!.output! : Object.fromEntries(terminals.map(step => [step.name, active.record.steps[step.id]!.output!]));
      active.record.status = Object.values(active.record.loops ?? {}).some(loop => loop.grants.length) || states.some(([, state]) => state.attempts.some(attempt => attempt.error || attempt.action !== 'execute')) ? 'completed-with-recovery' : 'completed';
      active.record.finishedAt = Date.now();
    }
    this.persist(active);
    this.settle(active);
  }

  private repeatOnly(active: ActiveExecution, loop: WorkflowGraph['loops'][number], id: string): boolean {
    const seen = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const step = active.graph.order.find(step => step.id === current)!;
      const edges = active.graph.outgoing.get(current)!;
      for (const outcome of step.kind === 'branch' ? ['true', 'false'] : ['success']) {
        const selected = edges.filter(edge => edge.outcome === outcome);
        if (!selected.length) return false;
        for (const edge of selected) {
          if (loop.backEdgeIds.includes(edge.id)) continue;
          if (!loop.memberIds.includes(edge.to)) return false;
          pending.push(edge.to);
        }
      }
    }
    return true;
  }

  private reserveTry(active: ActiveExecution, loop: WorkflowGraph['loops'][number]): boolean {
    const state = active.record.loops![loop.headerId]!;
    if (state.phase === 'repeating') return true;
    if (state.try >= loop.maxTries && !state.grants.some(grant => grant.activation === state.activation && grant.try === state.try + 1)) {
      state.phase = 'limit';
      return false;
    }
    state.try++;
    state.phase = 'repeating';
    return true;
  }

  private transitionLoops(active: ActiveExecution): boolean {
    if (active.record.testStepId) return false;
    let changed = false;
    for (const loop of [...active.graph.loops].reverse()) {
      const runtime = active.record.loops![loop.headerId]!;
      if (runtime.phase === 'exited' || runtime.phase === 'limit') continue;
      if (loop.memberIds.some(id => active.running.has(id) || ['pending', 'running', 'interrupted', 'blocked'].includes(active.record.steps[id]!.status))) continue;
      if (active.graph.loops.some(child => child.headerId !== loop.headerId && loop.memberIds.includes(child.headerId) && active.record.loops![child.headerId]!.phase !== 'exited')) continue;
      const failed = loop.memberIds.some(id => {
        const state = active.record.steps[id]!;
        return ['failed', 'timed-out'].includes(state.status) && (state.recovery || !active.graph.outgoing.get(id)!.some(edge => edge.outcome === state.outcome));
      });
      if (failed) continue;
      const back = active.graph.definition.edges.filter(edge => loop.backEdgeIds.includes(edge.id) && this.edgeState(active, edge) === 'selected');
      if (back.length) {
        if (!this.reserveTry(active, loop)) { changed = true; continue; }
        const header = active.graph.order.find(step => step.id === loop.headerId)!;
        const { mapping: _, ...unmapped } = header;
        const repeated = { ...unmapped, ...(header.repeatMapping ? { mapping: header.repeatMapping } : {}) };
        const input = this.input(active, repeated, back);
        runtime.headerInput = structuredClone(parseValue(active.graph.repeatInputSchemas.get(header.id)!, input));
        runtime.headerRecovery = back.some(edge => edge.outcome === 'failure' || edge.outcome === 'timeout' || active.record.steps[edge.from]!.recovery);
        runtime.phase = 'active';
        for (const id of loop.memberIds) {
          const state = active.record.steps[id]!;
          state.status = 'pending';
          delete state.output; delete state.outcome; delete state.recovery;
        }
        for (const child of active.graph.loops.filter(child => child.headerId !== loop.headerId && loop.memberIds.includes(child.headerId))) {
          const state = active.record.loops![child.headerId]!;
          state.phase = 'inactive'; state.try = 0; delete state.headerInput; delete state.headerRecovery;
        }
        changed = true;
      } else { runtime.phase = 'exited'; changed = true; }
    }
    return changed;
  }

  private guidedStep(active: ActiveExecution, step: WorkflowStep, attempt: StepAttempt): WorkflowStep {
    const copy = structuredClone(step);
    if (copy.kind === 'agent') {
      for (const identity of attempt.loops ?? []) {
        const grant = active.record.loops![identity.headerId]!.grants.find(grant => grant.activation === identity.activation && grant.try === identity.try);
        if (grant?.guidance) copy.instructions += '\nExtra try guidance:\n' + grant.guidance;
      }
    }
    return copy;
  }

  private settle(active: ActiveExecution): void {
    if (!occupied(active.record)) this.slots.delete(active.record.sessionId);
    for (const waiter of active.waiters.splice(0)) {
      if (active.persistenceError) waiter.reject(active.persistenceError);
      else waiter.resolve(structuredClone(active.record));
    }
  }

  private persist(active: ActiveExecution): void {
    try { this.store.saveExecution(active.record); }
    catch (error) {
      active.persistenceError = error;
      active.stopped = true;
      active.record.status = 'recovery-required';
      for (const step of Object.values(active.record.steps)) {
        if (step.status !== 'running') continue;
        step.status = 'interrupted';
        const attempt = step.attempts.at(-1)!;
        attempt.error = { kind: 'interrupted', message: 'Workflow storage failed; effects may already have occurred' };
        attempt.finishedAt = Date.now();
      }
      for (const running of active.running.values()) running.controller.abort();
      throw error;
    }
  }

  private input(active: ActiveExecution, step: WorkflowStep, edges: WorkflowEdge[]): Json {
    if (active.record.testStepId) return active.record.input;
    if (step.mapping) {
      const mapped = resolveMapping(active.record, step);
      if (mapped === undefined) throw new Error('Mapped input is missing');
      return mapped;
    }
    if (!edges.length) return active.record.input;
    const inputs = edges.map(edge => {
      const source = active.record.steps[edge.from]!;
      const attempt = source.attempts.at(-1)!;
      const value: Json = edge.outcome === 'failure' || edge.outcome === 'timeout' ? {
        input: attempt.input, error: { ...attempt.error! }, ...(attempt.partialOutput === undefined ? {} : { partialOutput: attempt.partialOutput }),
      } : source.output!;
      return [active.graph.order.find(candidate => candidate.id === edge.from)!.name, value] as const;
    });
    return inputs.length === 1 && step.kind !== 'join' ? inputs[0]![1] : Object.fromEntries(inputs);
  }

  private validateOutput(active: ActiveExecution, step: WorkflowStep, value: unknown): Json {
    const output = parseValue(declaredOutputSchema(step) ?? active.graph.outputSchemas.get(step.id)!, value);
    if (step.kind === 'shell' && !(step.acceptedExitCodes ?? [0]).includes((output as { exitCode: number }).exitCode)) throw new WorkflowStepError('Shell exit code was not accepted', output);
    return output;
  }

  private async execute(active: ActiveExecution, step: WorkflowStep, controller: AbortController): Promise<void> {
    const state = active.record.steps[step.id]!;
    if (active.stopped) {
      state.attempts.at(-1)!.finishedAt ??= Date.now();
      this.persist(active);
      return;
    }
    const attempt = state.attempts.at(-1)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      if (step.inputSchema) attempt.input = parseValue(step.inputSchema, attempt.input);
      this.persist(active);
      const timeout = step.timeoutMs ?? (step.kind === 'shell' || step.kind === 'typescript' ? 60_000 : undefined);
      if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
      let value: Json;
      if (step.kind === 'join') value = attempt.input;
      else if (step.kind === 'branch') {
        const actual = valueAt(attempt.input, step.condition.path);
        const condition = step.condition;
        switch (condition.operator) {
          case 'truthy': if (typeof actual !== 'boolean') throw new Error('Branch condition requires a boolean'); value = actual; break;
          case 'equals': value = isDeepStrictEqual(actual, condition.value); break;
          case 'not-equals': value = !isDeepStrictEqual(actual, condition.value); break;
          case 'greater-than': case 'less-than':
            if (typeof actual !== 'number') throw new Error('Branch condition requires a number');
            value = condition.operator === 'greater-than' ? actual > condition.value : actual < condition.value;
            break;
        }
      } else value = await this.executors[step.kind]!.execute({ sessionId: active.record.sessionId, scope: active.record.scope, executionId: active.record.id, step: this.guidedStep(active, step, attempt), input: structuredClone(attempt.input), inputSchema: active.graph.inputSchemas.get(step.id)!, permission: step.permission ?? active.record.definition.permission ?? 'auto-accept', signal: controller.signal });
      if (active.stopped) return;
      if (timedOut) throw new WorkflowStepError('Step timed out', value);
      const output = this.validateOutput(active, step, value);
      state.status = 'completed';
      state.output = output;
      state.outcome = step.kind === 'branch' ? output ? 'true' : 'false' : 'success';
      attempt.output = output;
    } catch (error) {
      if (active.stopped) return;
      state.status = timedOut ? 'timed-out' : 'failed';
      state.outcome = timedOut ? 'timeout' : 'failure';
      attempt.error = { kind: state.outcome, message: timedOut ? 'Step timed out' : error instanceof Error ? error.message : String(error) };
      if (error instanceof WorkflowStepError && error.partialOutput !== undefined) attempt.partialOutput = structuredClone(error.partialOutput);
    } finally {
      clearTimeout(timer);
      attempt.finishedAt ??= Date.now();
      this.persist(active);
    }
  }
}
