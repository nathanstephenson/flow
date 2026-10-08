import { createHash } from 'node:crypto';
import type { McpSession } from '../backend/mcp.ts';
import type { McpConnection } from '../protocol/mcp.ts';
import type { WorkflowMcpAuthoring, WorkflowMcpCatalogue, WorkflowMcpConnections } from '../protocol/workflow-mcp-authoring.ts';
import type { McpToolDiscovery } from '../protocol/workflows.ts';
import type { ConfigStore } from './config-store.ts';
import type { SessionHost } from './host.ts';
import { redactCredentials } from './credential-redaction.ts';
import { workflowAuthoringScopePath, type WorkflowAuthoringDirectory } from './workflow-authoring-scope.ts';
import { WorkflowAuthoringScopeChecks } from './workflow-authoring-scope-checks.ts';
import { connectionIdentity, snapshotTool } from './workflow-mcp.ts';

export type WorkflowMcpAuthoringOptions = {
  config: Pick<ConfigStore, 'projectRoot' | 'projectInclude' | 'mcpConnections' | 'filesystemIsolationEnabled'>;
  host: Pick<SessionHost, 'openWorkflowMcpAuthoring' | 'workflowMcpCredentials'>;
  scope: string;
};

type Entry = {
  scope: string;
  directory: WorkflowAuthoringDirectory;
  connection: McpConnection;
  isolation: boolean;
  generation: number;
  promise: Promise<McpToolDiscovery>;
  resolve: (value: McpToolDiscovery) => void;
  reject: (error: Error) => void;
  controller: AbortController;
  expires: number;
  timer: NodeJS.Timeout | undefined;
};
const TTL = 60_000;
const MAX_ENTRIES = 128;
const MAX_CLIENTS = 4;
const MAX_BYTES = 192_000;
const MAX_TOOLS = 256;
const MAX_ERRORS = 128;
const MAX_TOOL_BYTES = 48_000;

export class WorkflowMcpAuthoringService implements WorkflowMcpAuthoring {
  private readonly options: WorkflowMcpAuthoringOptions;
  private readonly scopes = new WorkflowAuthoringScopeChecks();
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly active = new Set<Promise<void>>();
  private fingerprint = '';
  private generation = 0;
  private stopped = false;
  private closing?: Promise<void>;

  constructor(options: WorkflowMcpAuthoringOptions) { this.options = options; }

  connections(projectId?: string): Promise<WorkflowMcpConnections> { return this.bounded(async () => this.metadata((await this.scope(projectId)).path)); }

  private metadata(scope: string): WorkflowMcpConnections {
    return this.redact({ scope, connections: this.options.config.mcpConnections().map(({ id, name, transport, enabledByDefault }) => ({ id, name, transport, enabledByDefault })) });
  }

  private async scope(projectId?: string): Promise<WorkflowAuthoringDirectory> {
    this.refresh();
    const generation = this.generation;
    try {
      const scope = await this.scopes.read(workflowAuthoringScopePath(this.options.config, this.options.scope, projectId));
      this.refresh();
      if (generation !== this.generation) throw new Error('MCP configuration changed; discover again');
      return scope;
    } catch (error) { throw this.safeError(error); }
  }

  discover(projectId: string | undefined, connectionId: string, refresh = false): Promise<McpToolDiscovery> {
    return this.bounded(deadline => this.discoverWithin(projectId, connectionId, refresh, deadline));
  }

  private async discoverWithin(projectId: string | undefined, connectionId: string, refresh: boolean, deadline: number): Promise<McpToolDiscovery> {
    const scope = await this.scope(projectId);
    this.checkDeadline(deadline);
    const generation = this.generation;
    const connection = this.options.config.mcpConnections().find(connection => connection.id === connectionId);
    if (!connection) throw new Error('Unknown MCP connection');
    const result = await this.request(scope, connection, deadline, generation, refresh);
    this.checkDeadline(deadline);
    await this.scopes.check(scope);
    this.checkDeadline(deadline);
    this.refresh();
    if (generation !== this.generation) throw new Error('MCP configuration changed; discover again');
    return this.redact(structuredClone(result));
  }

  catalogue(projectId?: string, expectedScope?: Pick<WorkflowMcpCatalogue, 'scope' | 'scopeIdentity'>): Promise<WorkflowMcpCatalogue> {
    return this.bounded(deadline => this.catalogueWithin(projectId, expectedScope, deadline));
  }

  private async catalogueWithin(projectId: string | undefined, expectedScope: Pick<WorkflowMcpCatalogue, 'scope' | 'scopeIdentity'> | undefined, deadline: number): Promise<WorkflowMcpCatalogue> {
    const scope = await this.scope(projectId);
    this.checkDeadline(deadline);
    if (expectedScope && (scope.path !== expectedScope.scope || scope.identity !== expectedScope.scopeIdentity))
      throw new Error('MCP authoring Scope changed. Close and reopen the builder.');
    const metadata = this.metadata(scope.path);
    const generation = this.generation;
    const selected = this.options.config.mcpConnections().filter(connection => connection.enabledByDefault || this.entries.has(this.key(scope, connection)));
    const results = await Promise.all(selected.map(async connection => {
      try { return { connection, discovery: await this.request(scope, connection, deadline, generation) }; }
      catch (error) { return { connection, error: this.safeError(error).message }; }
    }));
    this.checkDeadline(deadline);
    await this.scopes.check(scope);
    this.checkDeadline(deadline);
    this.refresh();
    if (generation !== this.generation) throw new Error('MCP configuration changed; read the catalogue again');
    const result: WorkflowMcpCatalogue = { ...metadata, scopeIdentity: scope.identity, tools: [], errors: [] };
    let omitted = false;
    const fits = () => bytes(result) <= MAX_BYTES - 1_024;
    const addError = (error: WorkflowMcpCatalogue['errors'][number]) => {
      if (result.errors.length >= MAX_ERRORS) { omitted = true; return; }
      result.errors.push(this.redact(error));
      if (!fits()) { result.errors.pop(); omitted = true; }
    };
    for (const { connection, error } of results) {
      if (error) addError({ connectionId: connection.id, connectionName: connection.name, message: error });
    }
    for (const { connection, discovery } of results) {
      const source = { connectionId: connection.id, connectionName: connection.name };
      for (const tool of discovery?.tools ?? []) {
        result.tools.push(this.redact(tool));
        if (result.tools.length > MAX_TOOLS || !fits()) {
          result.tools.pop();
          addError({ ...source, toolName: this.text(tool.toolName, 120), message: 'MCP catalogue limit exceeded; tool omitted' });
        }
      }
      for (const error of discovery?.errors ?? []) addError({ ...source, ...error });
    }
    if (omitted) result.errors.push({ connectionId: '', connectionName: '', message: 'MCP catalogue limit exceeded; additional diagnostics omitted' });
    return this.redact(result);
  }

  hasActiveWork(): boolean { return this.active.size > 0 || this.queue.length > 0 || this.scopes.hasActiveWork(); }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.invalidate(new Error('Workflow MCP authoring stopped'));
    return this.closing = Promise.allSettled([...this.active, this.scopes.shutdown()]).then(() => {});
  }

  private refresh(): void {
    if (this.stopped) throw new Error('Workflow MCP authoring stopped');
    const config = this.options.config;
    const fingerprint = createHash('sha256').update(JSON.stringify([config.projectRoot(), config.projectInclude(), config.mcpConnections(), config.filesystemIsolationEnabled(), this.options.host.workflowMcpCredentials()])).digest('hex');
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.invalidate(new Error('MCP configuration changed; discover again'));
    }
  }

  private invalidate(error: Error): void {
    this.generation++;
    for (const entry of this.entries.values()) { entry.controller.abort(error); entry.reject(error); }
    this.entries.clear();
    this.queue.length = 0;
  }

  private key(scope: WorkflowAuthoringDirectory, connection: McpConnection): string { return JSON.stringify([scope.path, scope.identity, connectionIdentity(connection)]); }

  private async request(scope: WorkflowAuthoringDirectory, connection: McpConnection, deadline: number, generation: number, refresh = false): Promise<McpToolDiscovery> {
    this.checkDeadline(deadline);
    await this.scopes.check(scope);
    this.refresh();
    if (generation !== this.generation) throw new Error('MCP configuration changed; discover again');
    this.checkDeadline(deadline);
    const key = this.key(scope, connection);
    const existing = this.entries.get(key);
    if (existing && (!existing.expires || (!refresh && existing.expires > Date.now()))) return existing.promise;
    if (existing) this.entries.delete(key);
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries].find(([, entry]) => entry.expires > 0);
      if (!oldest) return Promise.reject(new Error('MCP discovery capacity exceeded; try again later'));
      this.entries.delete(oldest[0]);
    }
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const promise = new Promise<McpToolDiscovery>((yes, no) => { resolve = yes; reject = no; });
    const entry: Entry = { scope: scope.path, directory: scope, connection: structuredClone(connection), isolation: this.options.config.filesystemIsolationEnabled(), generation: this.generation, promise, resolve, reject, controller: new AbortController(), expires: 0, timer: undefined };
    entry.controller.signal.addEventListener('abort', () => {
      clearTimeout(entry.timer);
      entry.expires = Date.now() + TTL;
      entry.reject(this.safeError(entry.controller.signal.reason));
      const queued = this.queue.indexOf(entry);
      if (queued !== -1) this.queue.splice(queued, 1);
    }, { once: true });
    // Admission, not execution, starts the deadline: exhausted cleanup capacity cannot strand a queue.
    entry.timer = setTimeout(() => entry.controller.abort(new Error('MCP discovery timed out')), Math.max(0, deadline - Date.now()));
    this.entries.set(key, entry);
    this.queue.push(entry);
    this.drain();
    return promise;
  }

  private drain(): void {
    while (!this.stopped && this.active.size < MAX_CLIENTS && this.queue.length) {
      const entry = this.queue.shift()!;
      const task = this.run(entry);
      this.active.add(task);
      void task.finally(() => { this.active.delete(task); this.drain(); });
    }
  }

  private async run(entry: Entry): Promise<void> {
    let session: McpSession | undefined, disposal: Promise<void> | undefined;
    const dispose = () => session ? disposal ??= session.dispose({ waitForExit: true }) : Promise.resolve();
    const { signal } = entry.controller;
    const abort = () => { void dispose().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    });
    const work = (async () => {
      await this.scopes.check(entry.directory);
      signal.throwIfAborted();
      session = await this.options.host.openWorkflowMcpAuthoring(entry.scope, entry.connection.id, entry.isolation, entry.directory.identity);
      signal.throwIfAborted();
      await this.scopes.check(entry.directory);
      signal.throwIfAborted();
      this.refresh();
      if (entry.generation !== this.generation) throw new Error('MCP configuration changed; discover again');
      if (connectionIdentity(session.connections[0]!) !== connectionIdentity(entry.connection)) throw new Error('MCP configuration changed; discover again');
      await session.open();
      signal.throwIfAborted();
      await this.scopes.check(entry.directory);
      signal.throwIfAborted();
      if (session.status()[0]?.state !== 'connected') throw new Error('MCP connection unavailable. Sign in in MCP Settings or reconfigure the server, then retry manually.');
      return this.snapshot(entry.connection, session);
    })();
    try {
      const completed = work.then(async result => { await dispose(); return result; });
      const result = await Promise.race([completed, cancelled]);
      signal.throwIfAborted();
      await this.scopes.check(entry.directory);
      signal.throwIfAborted();
      this.refresh();
      if (entry.generation !== this.generation) throw new Error('MCP configuration changed; discover again');
      entry.expires = Date.now() + TTL;
      entry.resolve(result);
    } catch (error) {
      const safe = this.safeError(error);
      entry.expires = Date.now() + TTL;
      entry.reject(safe);
    } finally {
      clearTimeout(entry.timer);
      await dispose().catch(() => {});
      await work.catch(() => {});
      await dispose().catch(() => {});
      signal.removeEventListener('abort', abort);
      signal.removeEventListener('abort', cancel);
    }
  }

  private snapshot(connection: McpConnection, session: McpSession): McpToolDiscovery {
    const result: McpToolDiscovery = { tools: [], errors: [] };
    let omitted = false;
    const error = (toolName: string, message: string) => {
      if (result.errors.length >= MAX_ERRORS) { omitted = true; return; }
      result.errors.push({ toolName: this.text(toolName, 120), message: this.text(message, 600) });
      if (bytes(result) > MAX_BYTES - 1_024) { result.errors.pop(); omitted = true; }
    };
    const tools = session.tools();
    for (const tool of tools.slice(0, MAX_TOOLS)) {
      try {
        const data = { connectionId: connection.id, connectionName: connection.name, serverIdentity: tool.serverIdentity, toolName: tool.definition.name, inputSchema: tool.definition.inputSchema, outputSchema: tool.definition.outputSchema };
        this.assertNoSecrets(data);
        if (bytes(data) > MAX_TOOL_BYTES) throw new Error('MCP tool exceeds the discovery size limit');
        const snapshot = snapshotTool(connection, tool);
        result.tools.push(snapshot);
        if (bytes(result) > MAX_BYTES - 64_000) { result.tools.pop(); throw new Error('MCP discovery size limit exceeded; tool omitted'); }
      } catch (failure) { error(tool.definition.name, this.safeError(failure).message); }
    }
    if (tools.length > MAX_TOOLS) error('', 'MCP tool count limit exceeded; additional tools omitted');
    if (omitted) result.errors.push({ toolName: '', message: 'MCP diagnostic limit exceeded; additional diagnostics omitted' });
    return result;
  }

  private checkDeadline(deadline: number): void {
    if (Date.now() >= deadline) throw new Error('MCP discovery timed out');
  }

  /** Caller wait includes Scope checks and queue admission; underlying cleanup remains owned. */
  private async bounded<T>(work: (deadline: number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work(deadline), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP discovery timed out')), Math.max(0, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }

  private assertNoSecrets(value: unknown): void {
    if (JSON.stringify(value) !== JSON.stringify(this.redact(value))) throw new Error('MCP tool metadata cannot contain credential values');
  }
  private redact<T>(value: T): T { return redactCredentials(value, this.options.host.workflowMcpCredentials()); }
  private text(value: string, limit: number): string { return this.redact(value).slice(0, limit); }
  private safeError(error: unknown): Error { return new Error(this.text(error instanceof Error ? error.message : String(error), 600)); }
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
