import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowSubagentHandle } from '../backend/types.ts';
import type { BackendEvent, Spend } from '../protocol/events.ts';
import type { WorkflowExecutionView, WorkflowRuntimeStatus, RecoverWorkflow } from '../protocol/workflow-executions.ts';
import type { Json, WorkflowDefinition, WorkflowExecution } from '../protocol/workflows.ts';
import { createCodeExecutors } from '../workflows/executors.ts';
import { parseValue } from '../workflows/schema.ts';
import { WorkflowStepError, WorkflowScheduler, type WorkflowExecutor, type WorkflowExecutors, type ExecutorContext } from '../workflows/scheduler.ts';
import { workflowRuntimeOptions } from '../workflows/runtime-settings.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import type { ConfigStore } from './config-store.ts';
import type { SecretStore } from './secret-store.ts';
import { SessionHost } from './host.ts';

type PrivateView = Omit<WorkflowExecutionView, 'execution'>;
type Launch = { sessionId: string; executionId: string; stepId: string; handle: WorkflowSubagentHandle };

export class WorkflowExecutionService {
  readonly scheduler: WorkflowScheduler;
  private readonly host: SessionHost;
  private readonly store: WorkflowStore;
  private readonly secrets: SecretStore;
  private readonly config: ConfigStore;
  private readonly runtimePath: string;
  private runtimeKey = '';
  private ready: Promise<void> = Promise.resolve();
  private code: WorkflowExecutors = {};
  private runtime!: WorkflowRuntimeStatus;
  private readonly snapshots = new Map<string, WorkflowExecutors>();
  private readonly views = new Map<string, PrivateView>();
  private readonly launches = new Map<string, Launch>();
  private readonly secretValues = new Map<string, string[]>();
  private readonly runtimeSnapshots = new Map<string, ReturnType<typeof workflowRuntimeOptions>>();
  private checkingCode: WorkflowExecutors | undefined;
  private readonly cancelling = new Map<string, { sessionId: string; done: Promise<WorkflowExecution> }>();

  constructor(host: SessionHost, store: WorkflowStore, secrets: SecretStore, config: ConfigStore, runtimePath: string) {
    this.host = host; this.store = store; this.secrets = secrets; this.config = config; this.runtimePath = runtimePath;
    const code = (kind: 'shell' | 'typescript'): WorkflowExecutor => ({
      check: (step, session) => {
        const executor = (this.checkingCode ?? this.code)[kind];
        if (!executor) throw new Error('Workflow runtime is unavailable');
        executor.check(step, session);
      },
      execute: async (context: ExecutorContext) => {
        const executor = this.snapshots.get(context.executionId)?.[kind];
        if (!executor) throw new Error('Workflow runtime is unavailable');
        try { return await executor.execute(context); } catch (error) { throw safeError(error, this.secretValues.get(context.executionId) ?? []); }
      },
    });
    this.scheduler = new WorkflowScheduler(store, {
      shell: code('shell'), typescript: code('typescript'),
      agent: {
        check: (step, session) => {
          if (step.kind !== 'agent') throw new Error('Invalid Agent step');
          const backend = host.workflowSession(session.sessionId).session;
          const model = backend?.capabilities.models.find(model => model.id === step.model);
          if (!backend?.startWorkflowSubagent || !model) throw new Error('Agent model is unavailable');
          if (model.effortLevels?.length ? !model.effortLevels.includes(step.effort) : step.effort !== 'off') throw new Error('Unsupported Effort');
        },
        execute: async context => {
          try { return await this.agent(context); } catch (error) { throw safeError(error, this.secretValues.get(context.executionId) ?? []); }
        },
      },
    });
    host.workflowOwner = this;
    this.refresh();
  }

  refresh(): void {
    const discovered = workflowRuntimeOptions(this.config.view().workflowRuntime);
    const options = { externalSandbox: discovered.externalSandbox, dockerImage: discovered.dockerImage, ...(discovered.nodePath ? { nodePath: discovered.nodePath } : {}), ...(discovered.dockerPath ? { dockerPath: discovered.dockerPath } : {}) };
    const key = JSON.stringify(options);
    if (key === this.runtimeKey) return;
    this.runtimeKey = key;
    this.runtime = { ...options, available: false, error: 'Workflow runtime readiness check in progress' };
    this.code = {};
    this.ready = (async () => {
      try {
        const executors = await createCodeExecutors({ runtimePath: this.runtimePath, nodePath: options.nodePath ?? '', sandbox: options.externalSandbox ? { enabled: true, available: !!options.dockerPath, image: options.dockerImage, ...(options.dockerPath ? { dockerPath: options.dockerPath } : {}) } : { enabled: false }, resolveSecret: async (name, signal) => this.secrets.resolve(name, signal) });
        if (key !== this.runtimeKey) return;
        this.code = executors;
        executors.shell.check({ id: 'probe', name: 'probe', kind: 'shell', command: 'true' }, { sessionId: 'probe', backend: 'probe', scope: '/' });
        this.runtime = { ...options, available: true };
      } catch {
        if (key === this.runtimeKey) this.runtime = { ...options, available: false, error: 'Configured workflow runtime is unavailable' };
      }
    })();
  }

  reconcile(): void {
    for (const sessionId of this.store.listSessionIds()) {
      for (const record of this.store.listExecutions(sessionId)) {
        const view = this.privateView(sessionId, record.id);
        if (view.spend) this.host.workflowSpend(sessionId, record.id, view.spend);
        this.publishResult(record);
      }
    }
  }

  status(): WorkflowRuntimeStatus { this.refresh(); return structuredClone(this.runtime); }

  list(sessionId: string) {
    this.host.logFor(sessionId);
    return { occupied: this.scheduler.occupied(sessionId), executions: this.store.listExecutions(sessionId).map(record => ({ id: record.id, workflowId: record.definition.id, name: record.definition.name, status: record.status, startedAt: record.startedAt, ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }), ...(record.testStepId ? { testStepId: record.testStepId } : {}) })) };
  }

  view(sessionId: string, executionId: string): WorkflowExecutionView {
    const execution = this.scheduler.get(sessionId, executionId);
    const view = this.privateView(sessionId, executionId);
    return structuredClone({ execution, ...view });
  }

  async start(sessionId: string, definition: WorkflowDefinition, input: Json, stepId?: string) {
    const identity = this.host.workflowSession(sessionId);
    if (definition.backend !== identity.backend) throw new Error('Backend Adapter mismatch');
    if (definition.projectId && !sameProject(definition.projectId, identity.projectId)) throw new Error('Workflow is restricted to another Project');
    if (this.scheduler.occupied(sessionId)) throw new WorkflowConflict();
    this.refresh(); await this.ready;
    const values = this.referencedSecrets(definition, stepId);
    assertNoSecrets(publicDefinition(definition), values);
    assertNoSecrets(input, values, true);
    const session = await this.host.openWorkflowSession(sessionId);
    if (definition.projectId) {
      if (!sameProject(definition.projectId, session.projectId)) throw new Error('Workflow is restricted to another Project');
      session.projectId = definition.projectId;
    }
    if (this.scheduler.occupied(sessionId)) throw new WorkflowConflict();
    this.host.assertWorkflowSession(sessionId, session.session);
    const record = this.scheduler.start(definition, session, input, stepId);
    this.secretValues.set(record.id, values);
    this.runtimeSnapshots.set(record.id, workflowRuntimeOptions(this.config.view().workflowRuntime));
    this.savePrivate(sessionId, record.id, this.privateView(sessionId, record.id));
    this.snapshots.set(record.id, this.code);
    this.watch(record);
    return this.view(sessionId, record.id);
  }

  async recover(sessionId: string, executionId: string, action: RecoverWorkflow) {
    this.refresh(); await this.ready;
    const session = await this.host.openWorkflowSession(sessionId);
    const saved = this.scheduler.get(sessionId, executionId);
    if (saved.status !== 'recovery-required') throw new WorkflowConflict();
    this.privateView(sessionId, executionId);
    const options = this.runtimeSnapshots.get(executionId) ?? workflowRuntimeOptions(this.config.view().workflowRuntime);
    const code = await createCodeExecutors({ runtimePath: this.runtimePath, nodePath: options.nodePath ?? '', sandbox: options.externalSandbox ? { enabled: true, available: !!options.dockerPath, image: options.dockerImage, ...(options.dockerPath ? { dockerPath: options.dockerPath } : {}) } : { enabled: false }, resolveSecret: async (name, signal) => this.secrets.resolve(name, signal) });
    if (saved.definition.projectId && !sameProject(saved.definition.projectId, session.projectId)) throw new Error('Workflow is restricted to another Project');
    const values = this.referencedSecrets(saved.definition, saved.testStepId);
    assertNoSecrets({ ...saved, definition: publicDefinition(saved.definition), action }, values);
    if (action.kind === 'supply') assertNoSecrets(action.output, values, true);
    this.secretValues.set(executionId, values);
    this.host.assertWorkflowSession(sessionId, session.session);
    let record: WorkflowExecution;
    this.checkingCode = code;
    try { record = this.scheduler.recover(session, executionId, action); }
    finally { this.checkingCode = undefined; }
    this.snapshots.set(executionId, code);
    this.watch(record);
    return this.view(sessionId, executionId);
  }

  async cancel(sessionId: string, executionId: string) {
    const pending = this.cancelling.get(executionId);
    if (pending?.sessionId === sessionId) { await pending.done; return this.view(sessionId, executionId); }
    const record = this.scheduler.get(sessionId, executionId);
    if (record.status !== 'running' && record.status !== 'recovery-required') return this.view(sessionId, executionId);
    const done = this.scheduler.cancel(sessionId, executionId);
    this.cancelling.set(executionId, { sessionId, done });
    try { await done; } finally { this.cancelling.delete(executionId); }
    return this.view(sessionId, executionId);
  }

  async stop(sessionId: string): Promise<void> {
    await Promise.all([...this.cancelling.values()].filter(item => item.sessionId === sessionId).map(item => item.done));
    for (const record of this.store.listExecutions(sessionId)) {
      if (record.status === 'running' || record.status === 'recovery-required') await this.scheduler.interrupt(sessionId, record.id);
    }
  }

  async forget(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    this.scheduler.forgetSession(sessionId);
    for (const record of this.store.listExecutions(sessionId)) {
      this.views.delete(record.id); this.snapshots.delete(record.id); this.secretValues.delete(record.id); this.runtimeSnapshots.delete(record.id);
    }
  }

  async answer(sessionId: string, executionId: string, body: { subagentId: string; askId?: string; answers?: string[][]; callId?: string; decision?: 'allow' | 'deny' | 'always' }) {
    const launch = this.launches.get(body.subagentId);
    if (!launch || launch.sessionId !== sessionId || launch.executionId !== executionId) throw new WorkflowConflict();
    const view = this.privateView(sessionId, executionId);
    if (body.askId !== undefined) {
      const enquiry = view.enquiries.find(item => item.subagentId === body.subagentId && item.askId === body.askId);
      if (!enquiry) throw new WorkflowConflict();
      if (body.answers?.length !== enquiry.questions.length) throw new Error('An Enquiry must be answered in one act');
      if (!await launch.handle.answerEnquiry(body.askId, body.answers!)) throw new WorkflowConflict();
    } else {
      const prompt = view.permissions.find(item => item.subagentId === body.subagentId && item.callId === body.callId);
      if (!prompt || !await launch.handle.answerPermission(body.callId!, body.decision!)) throw new WorkflowConflict();
      if (body.decision === 'always') this.host.authoriseWorkflowTool(prompt.tool);
    }
    return { accepted: true as const };
  }

  private async agent(context: ExecutorContext): Promise<Json> {
    if (context.step.kind !== 'agent') throw new Error('Invalid Agent step');
    const backend = this.host.workflowSession(context.sessionId).session;
    if (!backend?.startWorkflowSubagent) throw new Error('Workflow Backend Session is unavailable');
    context.signal.throwIfAborted();
    const aliases: Record<string, string> = Object.create(null);
    for (const [alias, reference] of Object.entries(context.step.secrets ?? {})) aliases[alias] = this.secrets.resolve(reference, context.signal);
    const values = [...(this.secretValues.get(context.executionId) ?? []), ...Object.values(aliases)];
    const id = randomUUID();
    const view = this.privateView(context.sessionId, context.executionId);
    const priorSpend = view.stepSpend[context.step.id];
    const handle = backend.startWorkflowSubagent({ id, name: context.step.name, instructions: context.step.instructions + '\nReturn only JSON matching this schema: ' + JSON.stringify(context.step.outputSchema) + (Object.keys(aliases).length ? '\nPrivate named secrets: ' + JSON.stringify(aliases) : ''), input: context.input, modelId: context.step.model, effort: context.step.effort, permissionMode: context.permission,
      emit: ({ event: rawEvent }) => {
        const oversized = JSON.stringify(rawEvent).length > 100_000;
        const event: BackendEvent | { type: 'spend'; spend: Spend } = oversized ? { type: 'notice', level: 'error', text: 'Workflow activity limit exceeded' } : redact(rawEvent, values);
        if (oversized) queueMicrotask(() => { void this.launches.get(id)?.handle.cancel().catch(() => {}); });
        const sequence = (view.activity.at(-1)?.sequence ?? 0) + 1;
        view.activity.push({ sequence, at: Date.now(), stepId: context.step.id, subagentId: id, event });
        while (view.activity.length > 200 || JSON.stringify(view.activity).length > 200_000) view.activity.shift();
        if (event.type === 'enquiry') {
          view.enquiries = view.enquiries.filter(item => item.subagentId !== id || item.askId !== event.askId);
          if (event.state === 'asked') view.enquiries.push({ subagentId: id, stepId: context.step.id, askId: event.askId, questions: event.questions });
        }
        if (event.type === 'permission') {
          view.permissions = view.permissions.filter(item => item.subagentId !== id || item.callId !== event.callId);
          if (event.state === 'asked') view.permissions.push({ subagentId: id, stepId: context.step.id, callId: event.callId, tool: event.tool });
        }
        if (event.type === 'spend') {
          view.stepSpend[context.step.id] = sumSpend([...(priorSpend ? [priorSpend] : []), event.spend]);
          view.spend = sumSpend(Object.values(view.stepSpend));
        }
        if (JSON.stringify([view.enquiries, view.permissions]).length > 200_000) {
          view.enquiries = view.enquiries.filter(item => item.subagentId !== id);
          view.permissions = view.permissions.filter(item => item.subagentId !== id);
          queueMicrotask(() => { void this.launches.get(id)?.handle.cancel().catch(() => {}); });
        }
        this.savePrivate(context.sessionId, context.executionId, view);
        if (event.type === 'spend' && view.spend) this.host.workflowSpend(context.sessionId, context.executionId, view.spend);
      },
    });
    if (context.permission === 'ask' && typeof handle.answerPermission !== 'function') {
      await handle.cancel();
      throw new Error('Workflow Agent permissions are unavailable');
    }
    this.launches.set(id, { sessionId: context.sessionId, executionId: context.executionId, stepId: context.step.id, handle });
    const abort = () => { void handle.cancel().catch(() => {}); };
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    try {
      const text = await handle.done;
      context.signal.throwIfAborted();
      const output = parseValue(context.step.outputSchema, JSON.parse(text));
      return redact(output, values);
    } catch (error) { throw safeError(error, values); }
    finally {
      await handle.cancel();
      context.signal.removeEventListener('abort', abort);
      this.launches.delete(id);
      view.enquiries = view.enquiries.filter(item => item.subagentId !== id);
      view.permissions = view.permissions.filter(item => item.subagentId !== id);
      this.savePrivate(context.sessionId, context.executionId, view);
    }
  }

  private referencedSecrets(definition: WorkflowDefinition, stepId?: string): string[] {
    return [...new Set(definition.steps.filter(step => !stepId || step.id === stepId).flatMap(step => Object.values(step.secrets ?? {})))].map(name => this.secrets.resolve(name));
  }

  private watch(record: WorkflowExecution): void {
    void this.scheduler.wait(record.sessionId, record.id).then(result => {
      this.snapshots.delete(record.id);
      this.secretValues.delete(record.id);
      this.publishResult(result);
    }).catch(() => {});
  }

  private publishResult(result: WorkflowExecution): void {
    if (result.status === 'completed' || result.status === 'completed-with-recovery') this.host.workflowNotice(result.sessionId, `Workflow ${result.definition.name} (${result.definition.id}), execution ${result.id}:\n${JSON.stringify(result.result)}`);
  }

  private privateView(sessionId: string, executionId: string): PrivateView {
    let view = this.views.get(executionId);
    if (!view) {
      try {
        const saved = JSON.parse(readFileSync(this.privatePath(sessionId, executionId), 'utf8'));
        const { runtime, ...activity } = saved;
        if (runtime) this.runtimeSnapshots.set(executionId, runtime);
        view = activity as PrivateView; view.enquiries = []; view.permissions = [];
      }
      catch { view = { activity: [], enquiries: [], permissions: [], stepSpend: {} }; }
      this.views.set(executionId, view);
    }
    return view;
  }

  private privatePath(sessionId: string, executionId: string): string {
    if (![sessionId, executionId].every(value => /^[a-zA-Z0-9_-]+$/.test(value))) throw new Error('Invalid execution identity');
    return join(this.store.stateRoot, 'sessions', sessionId, 'workflow-activity', executionId + '.json');
  }

  private savePrivate(sessionId: string, executionId: string, view: PrivateView): void {
    const path = this.privatePath(sessionId, executionId);
    const directoryPath = join(this.store.stateRoot, 'sessions', sessionId, 'workflow-activity');
    if (!existsSync(directoryPath)) {
      mkdirSync(directoryPath, { mode: 0o700 });
      const parent = openSync(join(this.store.stateRoot, 'sessions', sessionId), 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    const fd = openSync(path + '.tmp', 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...view, runtime: this.runtimeSnapshots.get(executionId) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(path + '.tmp', path);
    const directory = openSync(directoryPath, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export class WorkflowConflict extends Error { constructor() { super('Workflow decision or slot is no longer available'); } }

function sameProject(project: string, scope: string): boolean {
  try { return realpathSync(project) === scope; } catch { return false; }
}

function redact<T>(value: T, secrets: string[]): T {
  const patterns = secrets.filter(Boolean).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)]).sort((a, b) => b.length - a.length);
  const text = (value: string) => patterns.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, value]) => [text(key), visit(value)]));
    return item;
  };
  return visit(value) as T;
}

function publicDefinition(definition: WorkflowDefinition) {
  return { ...definition, steps: definition.steps.map(({ secrets, ...step }) => step) };
}

function assertNoSecrets(value: unknown, secrets: string[], checkKeys = false): void {
  const visit = (item: unknown): boolean => {
    if (typeof item === 'string') return redact(item, secrets) !== item;
    if (Array.isArray(item)) return item.some(visit);
    return !!item && typeof item === 'object' && Object.entries(item).some(([key, value]) => (checkKeys && visit(key)) || visit(value));
  };
  if (visit(value)) throw new Error('Saved workflow data cannot contain secret values');
}

function safeError(error: unknown, values: string[]): Error {
  const message = redact(error instanceof Error ? error.message : String(error), values);
  return error instanceof WorkflowStepError ? new WorkflowStepError(message, error.partialOutput === undefined ? undefined : redact(error.partialOutput, values)) : new Error(message);
}

function sumSpend(values: Spend[]): Spend {
  const result: Spend = { tokens: 0, cached: 0, costUSD: 0, models: [] };
  for (const value of values) {
    result.tokens += value.tokens; result.cached += value.cached; result.costUSD += value.costUSD;
    for (const model of value.models) {
      const existing = result.models.find(item => item.id === model.id);
      if (existing) { existing.tokens += model.tokens; existing.cached += model.cached; existing.costUSD += model.costUSD; }
      else result.models.push({ ...model });
    }
  }
  return result;
}
