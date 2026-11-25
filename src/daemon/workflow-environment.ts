import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import type { SessionHost } from './host.ts';
import type { FilesystemIsolationMode } from '../protocol/settings.ts';
import type { Sandbox, SandboxProvider } from '../isolation/sandbox.ts';
import { createSandbox, removeOwnedSandbox, sandboxMounts, sandboxUnavailable } from '../isolation/sandbox.ts';
import { nodeExecutionAssets } from '../isolation/node-assets.ts';
import { validateFilesystemScope } from '../isolation/filesystem.ts';
import { launchWorker } from '../backend/worker/launcher.ts';
import { WorkerRpc, waitForAbort } from '../backend/worker/rpc.ts';
import type { McpSession } from '../backend/mcp.ts';

export class WorkflowEnvironment {
  private sandbox: Sandbox | undefined;
  private release: (() => void) | undefined;
  private ownedProvider: SandboxProvider | undefined;
  private worker: ReturnType<typeof launchWorker> | undefined;
  private rpc: WorkerRpc | undefined;
  private workerFailure: Error | undefined;
  private mcp: Awaited<ReturnType<SessionHost['scheduledSandboxMcp']>> | undefined;
  private opening: Promise<void> | undefined;
  private recovering: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private readonly clients = new Set<McpSession>();
  readonly host: SessionHost;
  readonly ownerId: string;
  readonly scope: string;
  readonly connectionIds: string[];
  readonly mode: FilesystemIsolationMode;
  readonly stateDir: string;
  readonly readablePaths: string[];
  readonly scopeReadOnly: boolean;
  constructor(host: SessionHost, ownerId: string, scope: string, connectionIds: string[], mode: FilesystemIsolationMode, stateDir: string, readablePaths: string[] = [], scopeReadOnly = false) {
    this.host = host; this.ownerId = ownerId; this.scope = scope; this.connectionIds = connectionIds; this.mode = mode; this.stateDir = stateDir; this.readablePaths = readablePaths; this.scopeReadOnly = scopeReadOnly;
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    await waitForAbort(this.opening ??= this.open(signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal), signal);
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
  }

  recover(signal?: AbortSignal): Promise<void> {
    return this.recovering ??= (async () => {
      let failed = false;
      await this.opening?.catch(() => { failed = true; });
      signal?.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      if (failed || this.workerFailure) {
        await this.stopWorker();
        this.worker = undefined;
        this.rpc = undefined;
        this.mcp = undefined;
        this.workerFailure = undefined;
        this.opening = undefined;
      }
      await this.prepare(signal);
    })().finally(() => { this.recovering = undefined; });
  }

  private async open(signal: AbortSignal): Promise<void> {
    if (this.mode !== 'none') validateFilesystemScope({ scope: this.scope, expectedScope: this.scope, ...(this.host.filesystemStateRoot() ? { stateRoot: this.host.filesystemStateRoot()! } : {}) });
    if (this.mode !== 'sandbox') return;
    const support = this.host.sandboxSupport();
    if (!support?.supported || isSea()) throw sandboxUnavailable();
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const bundle = join(packageRoot, 'build/backend-worker.mjs');
    if (!existsSync(bundle)) throw new Error('Sandbox worker bundle unavailable');
    if (!this.sandbox) {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const shared = this.host.sharedSandbox();
      const roots = shared?.roots();
      if (roots && !roots.slice(0, 3).some(root => this.scope === root || this.scope.startsWith(root + '/'))) throw new Error('Scope is outside shared Sandbox roots');
      const attachment = shared ? this.host.scheduledSandboxMounts(this.scope) : { writable: [], readable: [] };
      const mounts = sandboxMounts([...(roots ?? (this.scopeReadOnly ? [this.stateDir] : [this.scope, this.stateDir])), ...attachment.writable],
        [...(this.scopeReadOnly ? [this.scope] : []), packageRoot, ...this.readablePaths, ...nodeExecutionAssets([bundle]), ...attachment.readable]);
      if (shared) {
        const lease = await shared.acquire(support.provider, roots![0]!, mounts, signal);
        this.sandbox = lease.sandbox; this.release = lease.release;
      } else {
        this.ownedProvider = support.provider;
        this.sandbox = await createSandbox(support.provider, { name: `flow-${this.ownerId}`, workspace: this.scopeReadOnly ? realpathSync(this.stateDir) : this.scope, mounts, env: {} }, join(this.stateDir, 'sandbox.json'), signal);
      }
    }
    signal.throwIfAborted();
    if (!this.connectionIds.length) return;
    const mcp = this.mcp = await this.host.scheduledSandboxMcp(this.scope, this.connectionIds);
    signal.throwIfAborted();
    const launch = this.sandbox.command(this.scope, [support.provider.nodePath, bundle], { FLOW_BACKEND_WORKER: '1' });
    const worker = this.worker = launchWorker({ command: launch.command, args: launch.args, env: {} });
    const fail = (error: Error) => {
      if (this.worker === worker) this.workerFailure ??= error;
      rpc.close(error);
    };
    const rpc = this.rpc = new WorkerRpc(message => {
      try { worker.send(message, error => { if (error) fail(error); }); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); throw error; }
    }, async (method, args) => {
      if (method !== 'mcp.token' || typeof args[0] !== 'string' || typeof args[1] !== 'boolean') throw new Error('Unexpected worker callback');
      return mcp.token(args[0], args[1]);
    }, () => {});
    worker.onMessage(message => rpc.receive(message), fail);
    worker.child.once('error', fail);
    worker.child.stdout?.once('close', () => fail(new Error('Workflow worker disconnected')));
    worker.child.once('exit', () => fail(new Error('Workflow worker exited')));
    try {
      await rpc.call('mcp.initialize', [{ scope: this.scope, connections: mcp.definitions() }], AbortSignal.any([signal, AbortSignal.timeout(300_000)]));
      signal.throwIfAborted();
      mcp.attach((method, args, callSignal) => rpc.call(method, args, callSignal));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      await this.stopWorker();
      throw error;
    }
  }

  async vm(): Promise<Sandbox> { await this.prepare(); if (!this.sandbox) throw sandboxUnavailable(); return this.sandbox; }
  async client(connectionId: string, signal?: AbortSignal): Promise<McpSession> {
    await this.prepare(signal);
    if (!this.connectionIds.includes(connectionId)) throw new Error('MCP connection not selected');
    if (this.workerFailure) throw this.workerFailure;
    const client = this.mode === 'sandbox' ? await this.mcp!.directView(connectionId, signal) : await this.host.scheduledMcp(this.scope, [connectionId], this.mode);
    this.clients.add(client);
    if (this.lifetime.signal.aborted || signal?.aborted) {
      await client.dispose({ waitForExit: true });
      this.clients.delete(client);
      this.lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
    }
    const dispose = client.dispose.bind(client);
    client.dispose = async (...args) => { await dispose(...args); this.clients.delete(client); };
    return client;
  }

  private async stopWorker(): Promise<void> {
    try { await this.worker?.stop(() => this.rpc!.call('dispose')); }
    finally { this.rpc?.close(new Error('Workflow worker stopped')); }
  }

  close(): Promise<void> {
    this.lifetime.abort(new Error('Workflow environment is stopping'));
    return this.closing ??= (async () => {
      await Promise.allSettled([this.opening, this.recovering]);
      const results = await Promise.allSettled([
        ...[...this.clients].map(client => Promise.resolve().then(() => client.dispose({ waitForExit: true }))),
        this.stopWorker(),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      try {
        if (this.release) { this.release(); this.release = undefined; this.sandbox = undefined; }
        else if (this.sandbox) { await this.sandbox.close(); this.sandbox = undefined; }
        else if (this.ownedProvider) await removeOwnedSandbox(this.ownedProvider, join(this.stateDir, 'sandbox.json'), `flow-${this.ownerId}`);
      } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Workflow environment cleanup failed');
    })().catch(error => { this.closing = undefined; throw error; });
  }
}
