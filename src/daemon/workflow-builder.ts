import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { BackendSession, BackendCreateOptions } from '../backend/types.ts';
import type { BackendEvent, EffortLevel, ModelInfo } from '../protocol/events.ts';
import { isDeepStrictEqual } from 'node:util';
import type { WorkflowDefinition, McpToolSnapshot } from '../protocol/workflows.ts';
import type { WorkflowMcpCatalogue } from '../protocol/workflow-mcp-authoring.ts';
import type { CreateWorkflowBuilder, WorkflowBuilderView } from '../protocol/workflow-builder.ts';
import { validateDefinition, workflowDefinitionValidator } from '../workflows/graph.ts';
import type { ConfigStore } from './config-store.ts';
import type { SessionHost } from './host.ts';
import { workflowAuthoringScope } from './workflow-authoring-scope.ts';
import { WorkflowBuilderFiles } from './workflow-builder-files.ts';
import { workflowBuilderInstructions } from './workflow-builder-guidance.ts';

const MAX_DEFINITION = 256_000;
const MAX_MESSAGES = 100;
const MAX_TEXT = 32_000;
const MAX_HISTORY = 256_000;
// A cold catalogue probe and a worker startup each have their own bounded launch window.
const defaults = { startupMs: 120_000, idleMs: 30 * 60_000, lifetimeMs: 2 * 60 * 60_000, turnMs: 10 * 60_000, disposeMs: 5_000, maxBuilders: 8 };
type Limits = typeof defaults;
type Host = Pick<SessionHost, 'workflowBuilderModels' | 'createWorkflowBuilderSession'>;
type Config = Pick<ConfigStore, 'projectRoot' | 'projectInclude' | 'defaultModel' | 'defaultEffort'>;
export interface WorkflowBuilderServiceOptions {
  host: Host;
  config: Config;
  scope: string;
  stateRoot: string;
  /** Additional credential/snapshot validation, e.g. executions.validateDefinitionCredentials. */
  validateDefinition?: (definition: WorkflowDefinition) => void;
  /** Host-owned metadata only; never callable MCP tools or transport credentials. */
  mcpCatalogue?: (scope: string, projectId: string | undefined, scopeIdentity: string) => Promise<WorkflowMcpCatalogue>;
  /** Internal lifecycle tuning, primarily for tests. Not an HTTP option. */
  limits?: Partial<Limits>;
}
type Entry = {
  view: WorkflowBuilderView;
  createdAt: number;
  touchedAt: number;
  closed: boolean;
  ready: boolean;
  files?: WorkflowBuilderFiles;
  directory?: string;
  session?: BackendSession;
  generation: number;
  meterGeneration?: number;
  startup?: AbortController;
  turn: number;
  writing: boolean;
  writePending?: Promise<string>;
  stopping?: Promise<void>;
  timer?: NodeJS.Timeout;
  modelId?: string;
  effort?: EffortLevel;
  models: ModelInfo[];
  originalMcpTools: McpToolSnapshot[];
  catalogueMcpTools: McpToolSnapshot[];
};

export class WorkflowBuilderRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const invalid = () => new WorkflowBuilderRequestError(400, 'Invalid workflow builder request');

/** Limits nesting and collection counts before recursive schema/graph validation. */
function bounded(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 20_000 || item.depth > 40) throw invalid();
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_DEFINITION) throw invalid();
}
const stepValidators = workflowDefinitionValidator.shape.steps.element.options;
const mcpReferenceValidator = stepValidators[5].shape.tool.omit({ connectionName: true, inputSchema: true, outputSchema: true });
const mcpDiagnostic = (id: unknown) => `MCP step ${JSON.stringify(id)} must use unchanged existing snapshots or exact tools from mcp-tools.json`;
const draftName = { name: stepValidators[0].shape.name.or(z.literal('')) };
const draftStepValidator = z.discriminatedUnion('kind', [
  stepValidators[0].extend({ ...draftName, model: z.string() }),
  stepValidators[1].extend(draftName), stepValidators[2].extend(draftName),
  stepValidators[3].extend(draftName), stepValidators[4].extend(draftName), stepValidators[5].extend(draftName),
]);
const draftValidator = workflowDefinitionValidator.extend({
  name: z.string(), steps: z.array(draftStepValidator).max(200), edges: workflowDefinitionValidator.shape.edges.max(500),
});
function definition(value: unknown, draft = false): WorkflowDefinition {
  bounded(value);
  // Creation is authoring input, not an executable graph: permit blank model selections and
  // broken connections/mappings for the agent to repair. Writes still require full validation.
  const parsed = draftValidator.parse(value) as WorkflowDefinition;
  return draft ? parsed : validateDefinition(parsed).definition;
}
function builderDefinition(value: unknown, entry: Entry): WorkflowDefinition {
  bounded(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const draft = value as Record<string, unknown>;
    if (draft.projectId === null && entry.view.definition.projectId === undefined) delete draft.projectId;
    let bytes = Buffer.byteLength(JSON.stringify(draft));
    if (Array.isArray(draft.steps)) {
      for (const step of draft.steps) {
        if (!step || typeof step !== 'object' || step.kind !== 'mcp') continue;
        const reference = mcpReferenceValidator.safeParse(step.tool);
        if (!reference.success) continue;
        const tool = [...entry.originalMcpTools, ...entry.catalogueMcpTools].find(tool =>
          Object.entries(reference.data).every(([key, value]) => tool[key as keyof McpToolSnapshot] === value));
        if (!tool) throw new Error(mcpDiagnostic(step.id));
        bytes += Buffer.byteLength(JSON.stringify(tool)) - Buffer.byteLength(JSON.stringify(step.tool));
        if (bytes > MAX_DEFINITION) throw invalid();
        step.tool = structuredClone(tool);
      }
    }
  }
  return definition(value);
}
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Ephemeral authoring only. No WorkflowStore reference, saved-definition writes, or Agent Session. */
export class WorkflowBuilderService {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<Entry, Promise<void>>();
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly options: WorkflowBuilderServiceOptions;
  private readonly limits: Limits;
  private readonly sweep: NodeJS.Timeout;
  private stopped = false;
  constructor(options: WorkflowBuilderServiceOptions) {
    this.options = options; this.limits = { ...defaults, ...options.limits };
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const entry of this.entries.values()) {
        if (now - entry.createdAt >= this.limits.lifetimeMs || (entry.view.status !== 'running' && now - entry.touchedAt >= this.limits.idleMs)) void this.close(entry.view.id);
      }
    }, Math.min(30_000, this.limits.idleMs, this.limits.lifetimeMs));
    this.sweep.unref();
  }

  async create(input: CreateWorkflowBuilder): Promise<WorkflowBuilderView> {
    if (this.stopped) throw new WorkflowBuilderRequestError(503, 'Workflow builder unavailable');
    // Timed-out adapter creates remain quarantined until their late result can be disposed.
    if (new Set([...this.entries.values(), ...this.opening.keys()]).size + this.disposing.size >= this.limits.maxBuilders) throw new WorkflowBuilderRequestError(429, 'Too many workflow builders');
    let draft: WorkflowDefinition;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['definition', 'modelId', 'effort'].includes(key))) throw invalid();
      if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId || input.modelId.length > 256)) throw invalid();
      draft = definition(input.definition, true);
      this.options.validateDefinition?.(draft);
    } catch { throw invalid(); }
    const now = Date.now();
    const entry: Entry = { view: { id: randomUUID(), definition: draft, scope: '', status: 'idle', messages: [] }, createdAt: now, touchedAt: now, closed: false, ready: false, generation: 0, turn: 0, writing: false, models: [], originalMcpTools: draft.steps.flatMap(step => step.kind === 'mcp' && step.tool.connectionId !== 'unselected' ? [structuredClone(step.tool)] : []), catalogueMcpTools: [] };
    this.entries.set(entry.view.id, entry);
    try {
      await within(this.trackStartup(entry, () => this.start(entry, input)), this.limits.startupMs);
      this.check(entry);
      entry.ready = true;
      return this.view(entry.view.id);
    } catch (error) {
      // Report a startup timeout promptly, but retain ownership of its eventual disposal.
      await within(this.close(entry.view.id), this.limits.disposeMs).catch(() => {});
      if (error instanceof WorkflowBuilderRequestError) throw error;
      throw new WorkflowBuilderRequestError(400, 'Workflow builder could not start');
    }
  }

  private trackStartup(entry: Entry, work: () => Promise<void>): Promise<void> {
    const startup = new AbortController();
    entry.startup = startup;
    const pending = Promise.resolve().then(() => { startup.signal.throwIfAborted(); return work(); }).finally(() => {
      if (this.opening.get(entry) === pending) this.opening.delete(entry);
      if (entry.startup === startup) delete entry.startup;
    });
    this.opening.set(entry, pending);
    return pending;
  }

  private check(entry: Entry, starting = false): void {
    if (entry.closed || this.stopped) throw new WorkflowBuilderRequestError(404, 'Workflow builder not found');
    if (starting) entry.startup?.signal.throwIfAborted();
  }

  private async start(entry: Entry, input: CreateWorkflowBuilder): Promise<void> {
    const { config, scope, stateRoot, host } = this.options;
    let root: string;
    try { root = workflowAuthoringScope(config, scope, entry.view.definition.projectId); }
    catch { throw new WorkflowBuilderRequestError(400, 'Workflow Project is not opted in or its Scope is unavailable'); }
    const files = await WorkflowBuilderFiles.create(root, stateRoot);
    if (entry.closed) { await files.close(); this.check(entry); }
    entry.files = files; entry.view.scope = files.scope;
    const directory = await mkdtemp(join(tmpdir(), 'flow-workflow-builder-'));
    if (entry.closed) { await rm(directory, { recursive: true, force: true }); this.check(entry); }
    entry.directory = directory;
    files.protect(directory);
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'workflow.json'), JSON.stringify(entry.view.definition), { mode: 0o600, flag: 'wx' });
    await mkdir(join(directory, 'backend'), { mode: 0o700 });
    await mkdir(join(directory, 'scope'), { mode: 0o700 });
    this.check(entry);
    const catalogue = await host.workflowBuilderModels(entry.view.definition.backend, join(directory, 'scope'));
    this.check(entry, true);
    if (!catalogue?.models.length) throw new WorkflowBuilderRequestError(400, 'Workflow Backend models are unavailable');
    entry.models = catalogue.models.slice(0, 500);
    const modelId = input.modelId ?? config.defaultModel(entry.view.definition.backend) ?? entry.models[0]!.id;
    const model = entry.models.find(model => model.id === modelId);
    if (!model) throw new WorkflowBuilderRequestError(400, 'Workflow builder model is unavailable');
    const levels = model.effortLevels ?? [];
    const effort = input.effort ?? (levels.length
      ? config.defaultEffort(entry.view.definition.backend) ?? (levels.includes('medium') ? 'medium' : levels[0]!)
      : 'off');
    if (levels.length ? !levels.includes(effort) : effort !== 'off') throw new WorkflowBuilderRequestError(400, 'Workflow builder Effort is unsupported');
    entry.modelId = modelId; entry.effort = effort;
    await this.open(entry);
  }

  private async open(entry: Entry): Promise<void> {
    this.check(entry, true);
    const generation = ++entry.generation;
    entry.meterGeneration = generation;
    delete entry.view.contextUsage;
    const instructions = await workflowBuilderInstructions(entry.view.definition, entry.models);
    this.check(entry, true);
    const live = () => { this.check(entry); if (entry.generation !== generation || entry.view.status !== 'running') throw new Error('Workflow builder turn is not active'); };
    const options: BackendCreateOptions = {
      scope: join(entry.directory!, 'scope'), stateDir: join(entry.directory!, 'backend'),
      ...(entry.startup ? { signal: entry.startup.signal } : {}),
      ...(entry.modelId ? { modelId: entry.modelId } : {}), ...(entry.effort ? { effort: entry.effort } : {}),
      ...(entry.view.spend ? { priorSpend: structuredClone(entry.view.spend) } : {}),
      workflowBuilder: {
        instructions,
        read: async path => {
          live();
          if (path === 'workflow.json') return JSON.stringify(entry.view.definition);
          if (path === 'mcp-tools.json') {
            await entry.files!.checkScope();
            live();
            const catalogue = await this.options.mcpCatalogue?.(entry.view.scope, entry.view.definition.projectId, entry.files!.scopeIdentity)
              ?? { scope: entry.view.scope, scopeIdentity: entry.files!.scopeIdentity, connections: [], tools: [], errors: [] };
            await entry.files!.checkScope();
            live();
            if (catalogue.scope !== entry.view.scope || catalogue.scopeIdentity !== entry.files!.scopeIdentity) throw new Error('MCP authoring Scope changed. Close and reopen the builder.');
            const content = JSON.stringify(catalogue);
            if (Buffer.byteLength(content) > 192_000) throw new Error('MCP tool catalogue is too large');
            entry.catalogueMcpTools = structuredClone(catalogue.tools);
            return content;
          }
          const content = await entry.files!.read(path);
          live();
          return content;
        },
        list: async path => { live(); return entry.files!.list(path); },
        write: async content => {
          live();
          const turn = entry.turn;
          if (entry.writing) throw new Error('Workflow draft write already in progress');
          entry.writing = true;
          let replaced = false;
          let diagnostic = 'Invalid workflow draft';
          const previous = JSON.stringify(entry.view.definition);
          try {
            if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_DEFINITION) throw new Error();
            let draft: WorkflowDefinition;
            try { draft = builderDefinition(JSON.parse(content), entry); }
            catch (error) {
              diagnostic = error instanceof z.ZodError
                ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)
                : error instanceof SyntaxError ? 'Invalid JSON definition'
                  : error instanceof Error ? error.message.slice(0, 500) : diagnostic;
              throw error;
            }
            diagnostic = 'Keep the workflow id, Backend Adapter and Project unchanged';
            if (draft.id !== entry.view.definition.id || draft.projectId !== entry.view.definition.projectId || draft.backend !== entry.view.definition.backend) throw new Error();
            diagnostic = 'Agent steps must use an available model and supported Effort';
            for (const step of draft.steps) {
              if (step.kind !== 'agent') continue;
              const model = entry.models.find(model => model.id === step.model);
              if (!model || (model.effortLevels?.length ? !model.effortLevels.includes(step.effort) : step.effort !== 'off')) throw new Error();
            }
            for (const step of draft.steps) {
              if (step.kind === 'mcp' && ![...entry.originalMcpTools, ...entry.catalogueMcpTools].some(tool => isDeepStrictEqual(tool, step.tool))) {
                diagnostic = mcpDiagnostic(step.id);
                throw new Error();
              }
            }
            diagnostic = 'Workflow credential or MCP snapshot validation failed';
            this.options.validateDefinition?.(draft);
            diagnostic = 'Workflow draft write interrupted';
            live();
            const temporary = join(entry.directory!, 'workflow.next');
            await writeFile(temporary, JSON.stringify(draft), { mode: 0o600 });
            live(); if (entry.turn !== turn) throw new Error();
            await rename(temporary, join(entry.directory!, 'workflow.json'));
            replaced = true;
            live(); if (entry.turn !== turn) throw new Error();
            entry.view.definition = draft;
            return 'Private workflow.json updated. The human must Apply and Save to persist it.';
          } catch {
            // Cancellation can win while the atomic rename is awaiting IO. The public draft is
            // unchanged; restore its private mirror before permitting another turn.
            if (replaced && !entry.closed) {
              const rollback = join(entry.directory!, 'workflow.rollback');
              await writeFile(rollback, previous, { mode: 0o600 }).then(() => rename(rollback, join(entry.directory!, 'workflow.json'))).catch(() => {});
            }
            throw new Error(`Invalid workflow draft; previous draft preserved. ${diagnostic}`);
          }
          finally { entry.writing = false; }
        },
      },
      emit: event => {
        if (event.type === 'context_usage') {
          if (event.spend && entry.meterGeneration === generation) entry.view.spend = structuredClone(event.spend);
          if (!entry.closed && entry.generation === generation) this.event(entry, event);
        } else if (!entry.closed && entry.generation === generation) this.event(entry, event);
      },
      onFailure: () => { if (!entry.closed && entry.generation === generation) this.fail(entry); },
    };
    const builder = options.workflowBuilder!;
    const performWrite = builder.write;
    builder.write = async (content: string): Promise<string> => {
      live();
      if (entry.writePending) throw new Error('Workflow draft write already in progress');
      const pending = performWrite(content);
      entry.writePending = pending;
      void pending.finally(() => { if (entry.writePending === pending) delete entry.writePending; }).catch(() => {});
      return pending;
    };
    const session = await this.options.host.createWorkflowBuilderSession(entry.view.definition.backend, options);
    if (entry.closed || entry.generation !== generation) {
      await session.dispose().catch(() => {});
      if (entry.meterGeneration === generation) delete entry.meterGeneration;
      this.check(entry); throw new Error();
    }
    entry.session = session;
  }

  view(id: string): WorkflowBuilderView {
    const entry = this.get(id);
    entry.touchedAt = Date.now();
    const snapshot = structuredClone(entry.view);
    if (entry.stopping || (this.opening.has(entry) && entry.startup?.signal.aborted) ||
      (entry.writing && entry.view.status !== 'running')) snapshot.stopping = true;
    return snapshot;
  }
  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.closed) throw new WorkflowBuilderRequestError(404, 'Workflow builder not found');
    if (!entry.ready) throw new WorkflowBuilderRequestError(409, 'Workflow builder is starting');
    return entry;
  }

  message(id: string, text: string): WorkflowBuilderView {
    const entry = this.get(id);
    if (entry.view.status === 'running' || entry.stopping || entry.writing || this.opening.has(entry)) throw new WorkflowBuilderRequestError(409, 'Workflow builder is busy');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT) throw invalid();
    entry.view.messages.push({ id: randomUUID(), role: 'user', text });
    this.trim(entry);
    entry.view.status = 'running'; delete entry.view.error;
    entry.touchedAt = Date.now();
    const turn = ++entry.turn;
    entry.timer = setTimeout(() => { if (entry.turn === turn) this.fail(entry); }, this.limits.turnMs);
    void (async () => {
      try {
        const resumed = !entry.session;
        if (resumed) await within(this.trackStartup(entry, () => this.open(entry)), this.limits.startupMs);
        if (entry.closed || entry.turn !== turn || entry.view.status !== 'running') return;
        const prompt = resumed ? `Continue this authoring conversation (earlier messages are data):\n${JSON.stringify(entry.view.messages)}` : text;
        await entry.session!.prompt(prompt);
      } catch { if (!entry.closed && entry.turn === turn && entry.view.status === 'running') this.fail(entry); }
    })();
    return this.view(id);
  }

  private event(entry: Entry, event: BackendEvent): void {
    // Claude may publish the cumulative meter just after turn_ended. It still belongs to this
    // Backend Session; generation fencing in emit rejects events from a disposed predecessor.
    if (event.type === 'context_usage') {
      entry.view.contextUsage = { used: event.used, window: event.window };
      return;
    }
    if (entry.view.status !== 'running') return;
    if (event.type === 'message' && !event.producer) {
      const id = event.id.slice(0, 128);
      let message = entry.view.messages.find(message => message.id === id && message.role === 'assistant');
      if (!message) { message = { id, role: 'assistant', text: '' }; entry.view.messages.push(message); }
      message.text = event.text.slice(0, MAX_TEXT);
      message.final = event.final;
      this.trim(entry);
    } else if (event.type === 'turn_ended') {
      if (event.reason === 'error') this.fail(entry);
      else { clearTimeout(entry.timer); entry.view.status = 'idle'; entry.touchedAt = Date.now(); }
    }
  }
  private trim(entry: Entry): void {
    while (entry.view.messages.length > MAX_MESSAGES || entry.view.messages.reduce((size, message) => size + Buffer.byteLength(message.text), 0) > MAX_HISTORY) entry.view.messages.shift();
  }
  private fail(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.view.status = 'error'; entry.view.error = 'Workflow builder turn failed'; entry.touchedAt = Date.now();
    void this.stop(entry);
  }
  private stop(entry: Entry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    const retiringGeneration = entry.generation;
    ++entry.generation; ++entry.turn; clearTimeout(entry.timer);
    entry.startup?.abort();
    const session = entry.session; delete entry.session;
    entry.stopping = (async () => {
      if (session) {
        // Start disposal even if abort is stuck. Restricted callbacks were already revoked.
        await within(session.abort().catch(() => {}), this.limits.disposeMs).catch(() => {});
        // Only callers' waits are bounded. Cleanup, capacity and the retiring meter stay owned
        // until actual disposal finishes, including a slow adapter beyond the response deadline.
        await session.dispose().catch(() => {});
      }
    })().finally(() => {
      if (session && entry.meterGeneration === retiringGeneration) delete entry.meterGeneration;
      delete entry.stopping;
    });
    return entry.stopping;
  }
  async abort(id: string): Promise<WorkflowBuilderView> {
    const entry = this.get(id);
    const stopped = this.stop(entry);
    entry.view.status = 'idle'; delete entry.view.error; entry.touchedAt = Date.now();
    await within(stopped, this.limits.disposeMs).catch(() => {});
    this.check(entry);
    return this.view(id);
  }
  close(id: string): Promise<void> {
    const pending = this.disposing.get(id);
    if (pending) return pending;
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    entry.closed = true; this.entries.delete(id);
    const disposal = (async () => {
      await this.stop(entry);
      // Startup/probe processes still need their neutral Scope and private state until exit.
      // Production workers honor the aborted startup signal; delayed adapters remain owned.
      await this.opening.get(entry)?.catch(() => {});
      await entry.writePending?.catch(() => {});
      await entry.files?.close();
      if (entry.directory) await rm(entry.directory, { recursive: true, force: true }).catch(() => {});
    })().finally(() => { this.disposing.delete(id); });
    this.disposing.set(id, disposal);
    return disposal;
  }
  hasActiveWork(): boolean { return this.opening.size > 0 || this.disposing.size > 0 || [...this.entries.values()].some(entry => !entry.ready || entry.view.status === 'running' || entry.writing || !!entry.stopping); }
  async shutdown(): Promise<void> {
    this.stopped = true; clearInterval(this.sweep);
    await Promise.all([...this.entries.keys()].map(id => this.close(id)));
    await Promise.all(this.disposing.values());
  }
}
