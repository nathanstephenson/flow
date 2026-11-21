import type { McpSession } from '../backend/mcp.ts';
import type { McpConnection } from '../protocol/mcp.ts';
import type { FilesystemIsolationMode } from '../protocol/settings.ts';
import type { WorkflowExecution } from '../protocol/workflows.ts';
import { executionOwner } from '../workflows/records.ts';
import { parseExecutionOwnerKey } from '../workflows/owner.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import type { SessionHost } from './host.ts';
import { WorkflowEnvironment } from './workflow-environment.ts';

type Runtime = NonNullable<WorkflowExecution['runtime']>;
interface ExecutionResources {
  connections(): McpConnection[];
  mcp(connectionId: string, mode: FilesystemIsolationMode, signal?: AbortSignal): Promise<McpSession>;
  sandbox(): ReturnType<SessionHost['workflowSandbox']>;
}

class SessionResources implements ExecutionResources {
  private readonly host: SessionHost;
  private readonly sessionId: string;
  constructor(host: SessionHost, sessionId: string) { this.host = host; this.sessionId = sessionId; }
  connections() { return this.host.workflowMcpConnections(this.sessionId); }
  mcp(connectionId: string, mode: FilesystemIsolationMode, signal?: AbortSignal) { return this.host.openWorkflowMcp(this.sessionId, connectionId, mode, signal); }
  sandbox() { return this.host.workflowSandbox(this.sessionId); }
}

export class OccurrenceResources implements ExecutionResources {
  private attached: Promise<string> | undefined;
  readonly environment: WorkflowEnvironment;
  private readonly host: SessionHost;
  private attachment: () => Promise<string>;
  constructor(environment: WorkflowEnvironment, host: SessionHost, attachment: () => Promise<string>) {
    this.environment = environment; this.host = host; this.attachment = attachment;
  }
  connections() { return this.host.scheduledConnections(this.environment.connectionIds); }
  mcp(connectionId: string, _mode: FilesystemIsolationMode, signal?: AbortSignal) { return this.environment.client(connectionId, signal); }
  sandbox() { return this.environment.vm(); }
  attach() { return this.attached ??= this.attachment().catch(error => { this.attached = undefined; throw error; }); }
  restoreAttachment(attach: () => Promise<string>) { this.attachment = attach; }
}

export class WorkflowExecutionResources {
  private readonly occurrences = new Map<string, OccurrenceResources>();
  private readonly host: SessionHost;
  private readonly store: WorkflowStore;
  private readonly runtimePath: string;
  constructor(host: SessionHost, store: WorkflowStore, runtimePath: string) { this.host = host; this.store = store; this.runtimePath = runtimePath; }

  get(owner: string): ExecutionResources {
    const resources = this.occurrences.get(owner);
    if (resources) return resources;
    const identity = parseExecutionOwnerKey(owner);
    if (identity.kind === 'occurrence') throw new Error('Scheduled environment unavailable');
    return new SessionResources(this.host, identity.sessionId);
  }

  occurrence(owner: string): OccurrenceResources {
    const resources = this.occurrences.get(owner);
    if (!resources) throw new Error('Scheduled environment unavailable');
    return resources;
  }

  create(owner: string, scope: string, connectionIds: string[], runtime: Runtime, attach: () => Promise<string>): OccurrenceResources {
    if (this.occurrences.has(owner)) throw new Error('Scheduled environment already exists');
    const environment = new WorkflowEnvironment(this.host, owner, scope, connectionIds, runtime.isolationMode, this.store.ownerPath(owner), [this.runtimePath]);
    const resources = new OccurrenceResources(environment, this.host, attach);
    this.occurrences.set(owner, resources);
    return resources;
  }

  restore(record: WorkflowExecution, connectionIds: string[], attach: () => Promise<string>): void {
    const owner = executionOwner(record);
    const existing = this.occurrences.get(owner);
    if (existing) existing.restoreAttachment(attach);
    else {
      if (!record.runtime) throw new Error('Captured scheduled runtime unavailable');
      this.create(owner, record.scope, connectionIds, record.runtime, attach);
    }
  }

  async close(owner: string): Promise<void> { await this.occurrences.get(owner)?.environment.close(); }
  async forget(owner: string): Promise<void> { await this.close(owner); this.occurrences.delete(owner); }
  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.occurrences.keys()].map(owner => this.close(owner)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Workflow environment cleanup failed');
  }
}
