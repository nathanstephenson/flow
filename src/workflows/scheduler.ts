import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Json, StepAttempt, WorkflowDefinition, WorkflowEdge, WorkflowExecution, WorkflowPermission, WorkflowStep } from '../protocol/workflows.ts';
import type { RecoverWorkflow } from '../protocol/workflow-executions.ts';
import { resolveMapping, validateDefinition } from './graph.ts';
import type { WorkflowGraph } from './graph.ts';
import { declaredOutputSchema, parseValue, valueAt } from './schema.ts';
import { validateMcpOutput } from './mcp.ts';
import { WorkflowStore } from './store.ts';
import { recoverySteps, savedDefinitionRevision, validateCompatibleDefinition } from './recovery.ts';
import { resolveWorkflowCalls } from './calls.ts';
import { invocationCheckpoint, invocationExecution } from './invocations.ts';

export interface WorkflowSession {
  sessionId: string;
  backend: string;
  scope: string;
  projectId?: string;
  matchesProject?: (projectId: string) => boolean;
}
export interface ExecutorContext {
  sessionId: string;
  scope: string;
  executionId: string;
  invocationId?: string;
  attempt?: number;
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
  mcp?: WorkflowExecutor;
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
  parent?: ActiveExecution;
  root?: ActiveExecution;
  callStepId?: string;
  callAttempt?: number;
  inheritedAsk?: boolean;
  calls: Map<string, { child: ActiveExecution; timer?: ReturnType<typeof setTimeout>; stopping?: Promise<void> }>;
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
  private readonly onResume: ((record: WorkflowExecution) => void) | undefined;

  constructor(store: WorkflowStore, executors: WorkflowExecutors, onResume?: (record: WorkflowExecution) => void) {
    this.store = store;
    this.executors = executors;
    this.onResume = onResume;
    for (const sessionId of store.listSessionIds()) {
      for (const record of store.listExecutions(sessionId)) {
        if (!occupied(record)) continue;
        if (this.slots.has(sessionId)) throw new Error('Multiple workflow executions occupy one Agent Session');
        const active = this.install(record);
        this.reconcile(active);
        this.persist(active);
      }
    }
  }

  occupied(sessionId: string): boolean { return this.slots.has(sessionId); }

  /** Whether the slot contains a full execution doing work, excluding tests and recovery waits. */
  activeFull(sessionId: string): boolean {
    const executionId = this.slots.get(sessionId);
    const record = executionId ? this.active.get(executionId)?.record : undefined;
    return record?.status === 'running' && record.testStepId === undefined;
  }

  forgetSession(sessionId: string): void {
    const executions = [...this.active.values()].filter(active => active.record.sessionId === sessionId);
    if (executions.some(active => this.hasWork(active) || active.record.status === 'running')) throw new Error('Workflow work must stop before forgetting an Agent Session');
    for (const active of executions) this.active.delete(active.record.id);
    this.slots.delete(sessionId);
  }

  start(definition: WorkflowDefinition, session: WorkflowSession, input: unknown, testStepId?: string, launchId?: string, namingEligible = false, capturedDefinitions?: Record<string, WorkflowDefinition>): WorkflowExecution {
    if (this.occupied(session.sessionId)) throw new Error('Agent Session workflow slot is occupied');
    const graph = validateDefinition(definition);
    if (graph.definition.backend !== session.backend) throw new Error('Backend Adapter mismatch');
    if (graph.definition.projectId && !(session.matchesProject?.(graph.definition.projectId) ?? graph.definition.projectId === session.projectId)) throw new Error('Workflow is restricted to another Project');
    const testStep = testStepId === undefined ? undefined : graph.order.find(step => step.id === testStepId);
    if (testStepId !== undefined && !testStep) throw new Error('Unknown test step');
    const retainedDefinitions = resolveWorkflowCalls(graph.definition, id => {
      if (!capturedDefinitions) return this.store.getDefinition(id);
      const retained = capturedDefinitions[id];
      if (!retained) throw new Error('Missing captured Workflow Definition');
      return retained;
    }, testStepId);
    this.check(testStep ? [testStep] : graph.order, session, retainedDefinitions);
    const parsed = parseValue(testStep ? graph.inputSchemas.get(testStep.id)! : graph.definition.inputSchema, input);
    const record: WorkflowExecution = {
      version: 1, id: randomUUID(), sessionId: session.sessionId, scope: session.scope,
      definition: graph.definition, input: parsed, status: 'running', startedAt: Date.now(),
      ...(graph.order.some(step => step.kind === 'workflow') ? { retainedDefinitions, invocations: {} } : {}),
      ...(launchId ? { launchId } : {}),
      ...(namingEligible && testStepId === undefined ? { naming: 'pending' as const } : {}),
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

  /** Atomically consume an automatic naming request before model work starts. */
  claimNaming(sessionId: string, executionId: string): boolean {
    const active = this.active.get(executionId);
    const record = active?.record.sessionId === sessionId ? active.record : this.store.getExecution(sessionId, executionId);
    if (record.naming !== 'pending' || record.testStepId) return false;
    record.naming = 'requested';
    if (active?.record === record) this.persist(active);
    else this.store.saveExecution(record);
    return true;
  }

  wait(sessionId: string, executionId: string): Promise<WorkflowExecution> {
    const active = this.require(sessionId, executionId);
    if (active.persistenceError) return Promise.reject(active.persistenceError);
    if (active.record.status !== 'running' && !this.hasWork(active)) return Promise.resolve(structuredClone(active.record));
    return new Promise((resolve, reject) => active.waiters.push({ resolve, reject }));
  }

  hasPendingDeadline(sessionId: string, executionId: string): boolean {
    const pending = (active: ActiveExecution): boolean => !active.stopped && [...active.calls.values()].some(call => call.timer !== undefined || pending(call.child));
    const active = this.active.get(executionId);
    return active?.record.sessionId === sessionId && pending(active);
  }

  async cancel(sessionId: string, executionId: string): Promise<WorkflowExecution> {
    const active = this.require(sessionId, executionId);
    if (!occupied(active.record)) return structuredClone(active.record);
    await this.stopTree(active, 'cancelled');
    this.settle(active);
    return structuredClone(active.record);
  }

  async interrupt(sessionId: string, executionId: string): Promise<WorkflowExecution> {
    const active = this.require(sessionId, executionId);
    if (!occupied(active.record)) return structuredClone(active.record);
    await this.stopTree(active, 'interrupted');
    this.settle(active);
    return structuredClone(active.record);
  }

  /** replacementDefinition is resolved from saved storage by the host, never from request JSON. */
  recover(session: WorkflowSession, executionId: string, action: RecoverWorkflow, replacementDefinition?: WorkflowDefinition): WorkflowExecution {
    const root = this.require(session.sessionId, executionId);
    const active = action.invocationId ? this.findInvocation(root, action.invocationId) : root;
    const record = active.record;
    if (record.status !== 'recovery-required' || this.hasWork(active)) throw new Error('Execution is not ready for recovery');
    if (record.definition.backend !== session.backend || record.scope !== session.scope) throw new Error('Recovery requires the original Scope and Backend Adapter');
    let graph = active.graph;
    if (action.kind === 'retry-updated') {
      if (!replacementDefinition) throw new Error('Updated recovery requires a saved Workflow Definition');
      if (savedDefinitionRevision(replacementDefinition) !== action.definitionRevision) throw new Error('Saved Workflow Definition revision changed');
      graph = validateCompatibleDefinition(record.definition, replacementDefinition, action.stepId);
    } else if (replacementDefinition !== undefined) throw new Error('Replacement definition requires retry-updated');
    // Check the corrected configuration, not the obsolete one. No checkpoint/graph mutation
    // happens until compatibility, authority, eligibility and all runtime checks pass.
    this.check(recoverySteps(root.record, action, replacementDefinition), session, root.record.retainedDefinitions);
    const limits = Object.entries(record.loops ?? {}).filter(([, loop]) => loop.phase === 'limit');
    if (action.kind === 'continue' && limits.length) throw new WorkflowLoopConflict('Loop limit requires an extra try or cancellation');
    if (action.kind === 'extend-loop') {
      const loop = record.loops?.[action.headerId];
      if (!loop || loop.phase !== 'limit' || loop.activation !== action.activation || loop.try !== action.try || loop.grants.some(grant => grant.activation === action.activation && grant.try === action.try + 1)) throw new WorkflowLoopConflict('Loop limit decision is no longer available');
      if (action.guidance !== undefined && (typeof action.guidance !== 'string' || action.guidance.length > 100_000)) throw new Error('Invalid loop guidance');
      loop.grants.push({ activation: loop.activation, try: loop.try + 1, ...(action.guidance === undefined ? {} : { guidance: action.guidance }) });
      loop.phase = 'active';
    } else if (action.kind !== 'continue') {
      const step = graph.order.find(step => step.id === action.stepId);
      const state = record.steps[action.stepId];
      if (!step || !state || !['interrupted', 'failed', 'timed-out'].includes(state.status)) throw new Error('Step does not require recovery');
      if (state.status !== 'interrupted' && !record.testStepId && !state.recovery && graph.outgoing.get(step.id)!.some(edge => edge.outcome === state.outcome)) throw new Error('Recover the failed handling step, not the handled failure');
      if (action.kind === 'supply') {
        const output = this.validateOutput(active, step, action.output);
        this.releaseCancelledCall(active, step.id);
        if (active.calls.has(step.id)) throw new Error('Cancel the owned call subtree before replacing its output');
        const attempt: StepAttempt = { number: state.attempts.length + 1, action: 'supply', startedAt: Date.now(), finishedAt: Date.now(), input: state.attempts.at(-1)!.input, output, ...(state.attempts.at(-1)!.loops ? { loops: structuredClone(state.attempts.at(-1)!.loops) } : {}) };
        state.attempts.push(attempt);
        state.output = output;
        state.status = 'completed';
        state.outcome = step.kind === 'branch' ? output ? 'true' : 'false' : 'success';
      } else {
        this.check([step], session, root.record.retainedDefinitions);
        this.releaseCancelledCall(active, step.id);
        if (action.kind === 'retry-updated') {
          const previousStep = record.definition.steps.find(previous => previous.id === step.id)!;
          (record.definitionUpdates ??= []).push({ stepId: step.id, previousStep: structuredClone(previousStep), nextStep: structuredClone(step), appliedAt: Date.now(), attempt: state.attempts.length + 1 });
          record.definition = graph.definition;
          active.graph = graph;
        }
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
    for (let parent = active.parent; parent; parent = parent.parent) {
      parent.stopped = false;
      parent.record.status = 'running';
      delete parent.record.finishedAt;
    }
    this.persist(active);
    delete root.persistenceError;
    this.resumeCalls(active);
    for (let parent = active.parent; parent; parent = parent.parent) this.resumeCalls(parent);
    this.pump(active);
    return structuredClone(root.record);
  }

  private check(steps: WorkflowStep[], session: WorkflowSession, manifest?: Record<string, WorkflowDefinition>, checked = new Set<string>()): void {
    for (const step of steps) {
      if (step.kind === 'branch' || step.kind === 'join') continue;
      if (step.kind === 'workflow') {
        const target = manifest?.[step.workflowId];
        if (!target) throw new Error('Missing retained called Workflow Definition');
        if (target.backend !== session.backend) throw new Error('Backend Adapter mismatch');
        if (target.projectId && !(session.matchesProject?.(target.projectId) ?? target.projectId === session.projectId)) throw new Error('Workflow is restricted to another Project');
        if (!checked.has(target.id)) { checked.add(target.id); this.check(target.steps, session, manifest, checked); }
        continue;
      }
      const executor = this.executors[step.kind];
      if (!executor) throw new Error(`Executor is unavailable: ${step.kind}`);
      executor.check(step, session);
    }
  }

  private install(record: WorkflowExecution): ActiveExecution {
    const active: ActiveExecution = { record, graph: validateDefinition(record.definition), running: new Map(), calls: new Map(), waiters: [], stopped: record.status !== 'running' };
    this.active.set(record.id, active);
    this.slots.set(record.sessionId, record.id);
    const installed = new Map<string, ActiveExecution>();
    const restore = (id: string): ActiveExecution => {
      const cached = installed.get(id);
      if (cached) return cached;
      const invocation = record.invocations![id]!;
      const parent = invocation.parentInvocationId ? restore(invocation.parentInvocationId) : active;
      const local = invocationExecution(record, id);
      const step = parent.graph.order.find(step => step.id === invocation.callStepId)!;
      const child: ActiveExecution = { record: local, graph: validateDefinition(local.definition), parent, root: active, callStepId: invocation.callStepId, callAttempt: invocation.callAttempt,
        inheritedAsk: parent.inheritedAsk || parent.record.definition.permission === 'ask' || step.permission === 'ask', running: new Map(), calls: new Map(), waiters: [], stopped: local.status !== 'running' };
      installed.set(id, child);
      const state = parent.record.steps[invocation.callStepId]!;
      if (state.attempts.length === invocation.callAttempt && state.status === 'running') parent.calls.set(invocation.callStepId, { child });
      return child;
    };
    for (const id of Object.keys(record.invocations ?? {})) restore(id);
    return active;
  }

  private hasWork(active: ActiveExecution): boolean {
    return active.running.size > 0 || [...active.calls.values()].some(call => !!call.stopping || this.hasWork(call.child));
  }

  private findInvocation(active: ActiveExecution, id: string): ActiveExecution {
    const pending = [active];
    while (pending.length) {
      const current = pending.pop()!;
      if (current !== active && current.record.id === id) return current;
      pending.push(...[...current.calls.values()].map(call => call.child));
    }
    throw new Error('Invocation does not require recovery');
  }

  private syncInvocations(active: ActiveExecution): void {
    const root = active.root ?? active;
    for (const call of active.calls.values()) {
      const child = call.child;
      this.syncInvocations(child);
      (root.record.invocations ??= {})[child.record.id] = invocationCheckpoint(child.record, {
        ...(active.parent ? { parentInvocationId: active.record.id } : {}), callStepId: child.callStepId!, callAttempt: child.callAttempt!, definitionId: child.record.definition.id,
      });
    }
  }

  private reconcile(active: ActiveExecution): void {
    for (const call of active.calls.values()) this.reconcile(call.child);
    if (!occupied(active.record)) return;
    for (const [id, state] of Object.entries(active.record.steps)) {
      if (state.status !== 'running' || active.calls.has(id)) continue;
      state.status = 'interrupted';
      const attempt = state.attempts.at(-1)!;
      attempt.error = { kind: 'interrupted', message: 'Execution was interrupted; effects may already have occurred' };
      attempt.finishedAt ??= Date.now();
    }
    active.record.status = 'recovery-required';
    active.stopped = true;
  }

  private releaseCancelledCall(active: ActiveExecution, stepId: string): void {
    const call = active.calls.get(stepId);
    if (call?.child.record.status !== 'cancelled') return;
    clearTimeout(call.timer);
    this.syncInvocations(active);
    active.calls.delete(stepId);
  }

  private failStorage(active: ActiveExecution): void {
    active.stopped = true;
    if (!active.parent || occupied(active.record)) active.record.status = 'recovery-required';
    for (const call of active.calls.values()) {
      clearTimeout(call.timer);
      this.failStorage(call.child);
    }
    for (const [id, state] of Object.entries(active.record.steps)) {
      if (state.status !== 'running' || active.calls.has(id)) continue;
      state.status = 'interrupted';
      const attempt = state.attempts.at(-1)!;
      attempt.error = { kind: 'interrupted', message: 'Workflow storage failed; effects may already have occurred' };
      attempt.finishedAt ??= Date.now();
    }
    for (const running of active.running.values()) running.controller.abort();
  }

  private async stopTree(active: ActiveExecution, reason: 'cancelled' | 'interrupted'): Promise<void> {
    const tree = [active];
    for (const current of tree) tree.push(...[...current.calls.values()].map(call => call.child));
    for (const current of tree) {
      current.stopped = true;
      if (!occupied(current.record)) continue;
      current.record.status = reason === 'cancelled' ? 'cancelled' : 'recovery-required';
      for (const [id, state] of Object.entries(current.record.steps)) {
        if (reason === 'cancelled' && ['pending', 'blocked', 'running', 'interrupted'].includes(state.status)) state.status = 'cancelled';
        else if (reason === 'interrupted' && state.status === 'running' && !current.calls.has(id)) {
          state.status = 'interrupted';
          const attempt = state.attempts.at(-1)!;
          attempt.error = { kind: 'interrupted', message: 'Execution was interrupted; effects may already have occurred' };
          attempt.finishedAt ??= Date.now();
        }
      }
    }
    const work = tree.flatMap(current => [...current.running.values()]);
    try { this.persist(active); }
    finally {
      for (const current of tree) for (const call of current.calls.values()) clearTimeout(call.timer);
      for (const running of work) running.controller.abort();
      await Promise.all(work.map(running => running.done));
      for (const current of tree) if (reason === 'cancelled' && current.record.status === 'cancelled') {
        current.record.finishedAt ??= Date.now();
        for (const state of Object.values(current.record.steps)) if (state.status === 'cancelled') {
          const attempt = state.attempts.at(-1);
          if (attempt) attempt.finishedAt ??= Date.now();
        }
      }
      this.persist(active);
    }
  }

  private startCall(active: ActiveExecution, step: Extract<WorkflowStep, { kind: 'workflow' }>, attempt: StepAttempt): void {
    const root = active.root ?? active;
    const definition = root.record.retainedDefinitions?.[step.workflowId];
    if (!definition) throw new Error('Missing retained called Workflow Definition');
    const graph = validateDefinition(definition);
    const record: WorkflowExecution = {
      version: 1, id: randomUUID(), sessionId: root.record.sessionId, scope: root.record.scope, definition: graph.definition,
      input: structuredClone(attempt.input), status: 'running', startedAt: Date.now(),
      steps: Object.fromEntries(graph.order.map(step => [step.id, { status: 'pending', attempts: [] }])),
      loops: Object.fromEntries(graph.loops.map(loop => [loop.headerId, { activation: 0, try: 0, phase: 'inactive', grants: [] }])),
    };
    const child: ActiveExecution = { record, graph, parent: active, root, callStepId: step.id, callAttempt: attempt.number,
      inheritedAsk: active.inheritedAsk || active.record.definition.permission === 'ask' || step.permission === 'ask',
      running: new Map(), calls: new Map(), waiters: [], stopped: false };
    active.calls.set(step.id, { child });
    if (step.timeoutMs !== undefined) attempt.deadlineAt = attempt.startedAt + step.timeoutMs;
    this.persist(active);
    this.armCall(active, step.id);
    if (attempt.deadlineAt === undefined || attempt.deadlineAt > Date.now()) this.pump(child);
  }

  private armCall(active: ActiveExecution, stepId: string): void {
    const call = active.calls.get(stepId)!;
    clearTimeout(call.timer);
    const deadline = active.record.steps[stepId]!.attempts.at(-1)!.deadlineAt;
    if (deadline === undefined || call.stopping) return;
    call.timer = setTimeout(() => {
      call.stopping = this.stopTree(call.child, 'cancelled').then(() => {
        if (active.stopped) return;
        const state = active.record.steps[stepId]!;
        const attempt = state.attempts.at(-1)!;
        state.status = 'timed-out'; state.outcome = 'timeout';
        attempt.error = { kind: 'timeout', message: 'Step timed out' };
        attempt.finishedAt = Date.now();
        this.persist(active);
        active.calls.delete(stepId);
        const root = active.root ?? active;
        const resumed = root.record.status === 'recovery-required';
        for (let current: ActiveExecution | undefined = active; current; current = current.parent) {
          current.record.status = 'running';
          delete current.record.finishedAt;
        }
        if (resumed) this.onResume?.(structuredClone(root.record));
        this.pump(active);
      }).catch(error => { (active.root ?? active).persistenceError = error; this.failStorage(active.root ?? active); this.settle(active.root ?? active); }).finally(() => { delete call.stopping; });
    }, Math.max(0, deadline - Date.now()));
  }

  private resumeCalls(active: ActiveExecution): void {
    for (const [stepId, call] of active.calls) {
      this.armCall(active, stepId);
      if (call.child.record.status === 'completed' || call.child.record.status === 'completed-with-recovery') this.completeCall(call.child);
    }
  }

  private completeCall(child: ActiveExecution): void {
    const parent = child.parent!;
    const stepId = child.callStepId!;
    const call = parent.calls.get(stepId);
    if (!call || call.child !== child || call.stopping || parent.stopped) return;
    if (child.record.status === 'completed' || child.record.status === 'completed-with-recovery') {
      clearTimeout(call.timer);
      const state = parent.record.steps[stepId]!;
      const attempt = state.attempts.at(-1)!;
      const step = parent.graph.order.find(step => step.id === stepId)!;
      try {
        const output = this.validateOutput(parent, step, child.record.result);
        state.status = 'completed'; state.outcome = 'success'; state.output = output; attempt.output = output;
      } catch (error) {
        state.status = 'failed'; state.outcome = 'failure';
        attempt.error = { kind: 'failure', message: error instanceof Error ? error.message : String(error) };
      }
      attempt.finishedAt = Date.now();
      this.persist(child);
      parent.calls.delete(stepId);
    }
    this.pump(parent);
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

  private hasExpiredAncestor(active: ActiveExecution): boolean {
    const now = Date.now();
    for (let child = active; child.parent; child = child.parent) {
      const deadline = child.parent.record.steps[child.callStepId!]!.attempts[child.callAttempt! - 1]!.deadlineAt;
      if (deadline !== undefined && deadline <= now) return true;
    }
    return false;
  }

  private pump(active: ActiveExecution): void {
    if (active.stopped || active.record.status !== 'running' || this.hasExpiredAncestor(active)) return;
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
      let input: Json = null;
      let inputError: unknown;
      try { input = retry ? previous.input : header?.headerInput !== undefined ? header.headerInput : this.input(active, step, selected); } catch (error) { inputError = error; }
      state.attempts.push({ number: state.attempts.length + 1, action: retry ? 'retry' : 'execute', startedAt: Date.now(), input, ...(identities.length ? { loops: identities } : {}) });
      const done = Promise.resolve().then(() => this.execute(active, step, controller, inputError)).finally(() => {
        active.running.delete(step.id);
        const root = active.root ?? active;
        if (active.stopped) {
          if (!this.hasWork(root) && root.persistenceError) this.settle(root);
          return;
        }
        this.pump(active);
      }).catch(error => {
        const root = active.root ?? active;
        root.persistenceError = error;
        this.failStorage(root);
        if (!this.hasWork(root)) this.settle(root);
      });
      state.status = 'running';
      active.running.set(step.id, { controller, done });
    }
    this.persist(active);
    if (this.hasWork(active)) return;
    if (this.transitionLoops(active)) { this.persist(active); this.pump(active); return; }
    const states = Object.entries(active.record.steps);
    const unresolved = active.calls.size > 0 || Object.values(active.record.loops ?? {}).some(loop => loop.phase === 'limit') || states.some(([id, state]) => ['pending', 'interrupted', 'blocked'].includes(state.status) || ((state.status === 'failed' || state.status === 'timed-out') && (active.record.testStepId || state.recovery || !active.graph.outgoing.get(id)!.some(edge => edge.outcome === state.outcome))));
    if (unresolved) active.record.status = 'recovery-required';
    else {
      const terminals = active.graph.order.filter(step => active.record.steps[step.id]!.status === 'completed' && (active.record.testStepId || !active.graph.outgoing.get(step.id)!.some(edge => this.edgeState(active, edge) === 'selected')));
      active.record.result = terminals.length === 1 ? active.record.steps[terminals[0]!.id]!.output! : Object.fromEntries(terminals.map(step => [step.name, active.record.steps[step.id]!.output!]));
      active.record.status = Object.values(active.record.loops ?? {}).some(loop => loop.grants.length) || Object.values((active.root ?? active).record.invocations ?? {}).some(invocation => invocation.status === 'completed-with-recovery') || states.some(([, state]) => state.attempts.some(attempt => attempt.error || attempt.action !== 'execute')) ? 'completed-with-recovery' : 'completed';
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
    if (active.parent) {
      if (!active.stopped) this.completeCall(active);
      return;
    }
    if (!occupied(active.record)) this.slots.delete(active.record.sessionId);
    for (const waiter of active.waiters.splice(0)) {
      if (active.persistenceError) waiter.reject(active.persistenceError);
      else waiter.resolve(structuredClone(active.record));
    }
  }

  private persist(active: ActiveExecution): void {
    const root = active.root ?? active;
    try {
      this.syncInvocations(root);
      this.store.saveExecution(root.record);
    } catch (error) {
      root.persistenceError = error;
      this.failStorage(root);
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
    if (step.kind === 'mcp') return validateMcpOutput(step.tool, value);
    const output = parseValue(declaredOutputSchema(step) ?? active.graph.outputSchemas.get(step.id)!, value);
    if (step.kind === 'shell' && !(step.acceptedExitCodes ?? [0]).includes((output as { exitCode: number }).exitCode)) throw new WorkflowStepError('Shell exit code was not accepted', output);
    return output;
  }

  private async execute(active: ActiveExecution, step: WorkflowStep, controller: AbortController, inputError?: unknown): Promise<void> {
    const state = active.record.steps[step.id]!;
    if (active.stopped) {
      state.attempts.at(-1)!.finishedAt ??= Date.now();
      this.persist(active);
      return;
    }
    if (this.hasExpiredAncestor(active)) return;
    const attempt = state.attempts.at(-1)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      if (inputError) throw inputError;
      if (step.inputSchema) attempt.input = parseValue(step.inputSchema, attempt.input);
      if (step.kind === 'workflow') {
        attempt.input = parseValue(step.contract.inputSchema, attempt.input);
        this.startCall(active, step, attempt);
        return;
      }
      this.persist(active);
      if (this.hasExpiredAncestor(active)) return;
      const timeout = step.timeoutMs ?? (step.kind === 'shell' || step.kind === 'typescript' || step.kind === 'mcp' ? 60_000 : undefined);
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
      } else value = await this.executors[step.kind]!.execute({ sessionId: active.record.sessionId, scope: active.record.scope, executionId: (active.root ?? active).record.id, ...(active.parent ? { invocationId: active.record.id } : {}), attempt: attempt.number, step: this.guidedStep(active, step, attempt), input: structuredClone(attempt.input), inputSchema: active.graph.inputSchemas.get(step.id)!, permission: active.inheritedAsk ? 'ask' : step.permission ?? active.record.definition.permission ?? 'auto-accept', signal: controller.signal });
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
      if (!active.calls.has(step.id)) attempt.finishedAt ??= Date.now();
      this.persist(active);
    }
  }
}
