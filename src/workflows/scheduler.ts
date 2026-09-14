import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json, StepAttempt, WorkflowDefinition, WorkflowEdge, WorkflowExecution, WorkflowPermission, WorkflowStep } from '../protocol/workflows.ts';
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
      ...(testStepId === undefined ? {} : { testStepId }),
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

  recover(session: WorkflowSession, executionId: string, action: { kind: 'retry'; stepId: string } | { kind: 'supply'; stepId: string; output: unknown } | { kind: 'continue' }): WorkflowExecution {
    const active = this.require(session.sessionId, executionId);
    const record = active.record;
    if (record.status !== 'recovery-required' || active.running.size) throw new Error('Execution is not ready for recovery');
    if (record.definition.backend !== session.backend || record.scope !== session.scope) throw new Error('Recovery requires the original Scope and Backend Adapter');
    this.check(active.graph.order.filter(step => (!record.testStepId || step.id === record.testStepId) && record.steps[step.id]!.status !== 'completed' && !(action.kind === 'supply' && step.id === action.stepId)), session);
    if (action.kind !== 'continue') {
      const step = active.graph.order.find(step => step.id === action.stepId);
      const state = record.steps[action.stepId];
      if (!step || !state || !['interrupted', 'failed', 'timed-out'].includes(state.status)) throw new Error('Step does not require recovery');
      if (state.status !== 'interrupted' && !record.testStepId && !state.recovery && active.graph.outgoing.get(step.id)!.some(edge => edge.outcome === state.outcome)) throw new Error('Recover the failed handling step, not the handled failure');
      if (action.kind === 'supply') {
        const output = this.validateOutput(active, step, action.output);
        const attempt: StepAttempt = { number: state.attempts.length + 1, action: 'supply', startedAt: Date.now(), finishedAt: Date.now(), input: state.attempts.at(-1)!.input, output };
        state.attempts.push(attempt);
        state.output = output;
        state.status = 'completed';
        state.outcome = step.kind === 'branch' ? output ? 'true' : 'false' : 'success';
      } else {
        this.check([step], session);
        state.status = 'pending';
        delete state.outcome;
      }
    } else if (Object.values(record.steps).some(step => ['interrupted', 'failed', 'timed-out'].includes(step.status) && !step.outcome)) throw new Error('Recover interrupted steps first');
    for (const step of Object.values(record.steps)) if (step.status === 'blocked' || (step.status === 'skipped' && !record.testStepId)) step.status = 'pending';
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
    for (const step of active.graph.order) {
      const state = active.record.steps[step.id]!;
      if (state.status !== 'pending') continue;
      const edges = active.record.testStepId ? [] : active.graph.incoming.get(step.id)!;
      const statuses = edges.map(edge => this.edgeState(active, edge));
      if (statuses.includes('waiting')) continue;
      if (statuses.includes('blocked')) { state.status = 'blocked'; continue; }
      if (edges.length && !statuses.includes('selected')) { state.status = 'skipped'; continue; }
      const selected = edges.filter((_, index) => statuses[index] === 'selected');
      state.recovery = selected.some(edge => edge.outcome === 'failure' || edge.outcome === 'timeout' || active.record.steps[edge.from]!.recovery);
      const controller = new AbortController();
      state.attempts.push({ number: state.attempts.length + 1, action: state.attempts.length ? 'retry' : 'execute', startedAt: Date.now(), input: this.input(active, step, selected) });
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
    const states = Object.entries(active.record.steps);
    const unresolved = states.some(([id, state]) => ['interrupted', 'blocked'].includes(state.status) || ((state.status === 'failed' || state.status === 'timed-out') && (active.record.testStepId || state.recovery || !active.graph.outgoing.get(id)!.some(edge => edge.outcome === state.outcome))));
    if (unresolved) active.record.status = 'recovery-required';
    else {
      const terminals = active.graph.order.filter(step => active.record.steps[step.id]!.status === 'completed' && (active.record.testStepId || !active.graph.outgoing.get(step.id)!.some(edge => this.edgeState(active, edge) === 'selected')));
      active.record.result = terminals.length === 1 ? active.record.steps[terminals[0]!.id]!.output! : Object.fromEntries(terminals.map(step => [step.name, active.record.steps[step.id]!.output!]));
      active.record.status = states.some(([, state]) => state.attempts.some(attempt => attempt.error || attempt.action !== 'execute')) ? 'completed-with-recovery' : 'completed';
      active.record.finishedAt = Date.now();
    }
    this.persist(active);
    this.settle(active);
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
      } else value = await this.executors[step.kind]!.execute({ sessionId: active.record.sessionId, scope: active.record.scope, executionId: active.record.id, step: structuredClone(step), input: structuredClone(attempt.input), inputSchema: active.graph.inputSchemas.get(step.id)!, permission: step.permission ?? active.record.definition.permission ?? 'auto-accept', signal: controller.signal });
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
