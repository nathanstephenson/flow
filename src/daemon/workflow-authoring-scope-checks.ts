import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { launchWorker } from '../backend/worker/launcher.ts';
import { checkWorkflowAuthoringDirectory, workflowAuthoringDirectory, type WorkflowAuthoringDirectory } from './workflow-authoring-scope.ts';

type Reader = { cancel: () => void; cleanup: Promise<void> };
type Options = { linuxSync?: boolean; launch?: typeof launchWorker };
const unavailable = () => new Error('Workflow authoring Scope unavailable');
const changed = () => new Error('Workflow authoring Scope changed; discover again');
const validPath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0');
const validDirectory = (value: unknown): value is WorkflowAuthoringDirectory => {
  const directory = value as WorkflowAuthoringDirectory | null;
  return !!directory && validPath(directory.path) && isAbsolute(directory.path) && resolve(directory.path) === directory.path &&
    typeof directory.identity === 'string' && /^\d{1,40}:\d{1,40}$/.test(directory.identity);
};

export class WorkflowAuthoringScopeChecks {
  private readonly readers = new Set<Reader>();
  private readonly pending = new Map<string, Promise<WorkflowAuthoringDirectory>>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly options: Options;

  constructor(options: Options = {}) { this.options = options; }

  async read(path: string): Promise<WorkflowAuthoringDirectory> {
    if (this.closed || !validPath(path)) throw unavailable();
    if (process.platform === 'linux' && this.options.linuxSync !== false) {
      try { return workflowAuthoringDirectory(realpathSync(path)); } catch { throw unavailable(); }
    }
    return this.inspect({ operation: 'read', path: resolve(path) });
  }

  async check(directory: WorkflowAuthoringDirectory): Promise<void> {
    if (this.closed || !validDirectory(directory)) throw changed();
    const pinned = { path: directory.path, identity: directory.identity };
    if (process.platform === 'linux' && this.options.linuxSync !== false) {
      try { return checkWorkflowAuthoringDirectory(pinned); } catch { throw changed(); }
    }
    const actual = await this.inspect({ operation: 'check', ...pinned });
    if (actual.path !== pinned.path || actual.identity !== pinned.identity) throw changed();
  }

  hasActiveWork(): boolean { return this.readers.size > 0; }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      const readers = [...this.readers];
      for (const reader of readers) reader.cancel();
      await Promise.all(readers.map(reader => reader.cleanup));
    })();
  }

  private inspect(request: { operation: 'read' | 'check'; path: string; identity?: string }): Promise<WorkflowAuthoringDirectory> {
    if (this.closed) return Promise.reject(unavailable());
    const key = JSON.stringify(request);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.inspectOwned(request);
    this.pending.set(key, pending);
    const settled = () => { if (this.pending.get(key) === pending) this.pending.delete(key); };
    void pending.then(settled, settled);
    return pending;
  }

  private inspectOwned(request: { operation: 'read' | 'check'; path: string; identity?: string }): Promise<WorkflowAuthoringDirectory> {
    if (this.closed || this.readers.size >= 4 || !validPath(request.path)) return Promise.reject(unavailable());
    return new Promise((accept, reject) => {
      let settled = false;
      let reader: Reader | undefined;
      let helper: ReturnType<typeof launchWorker> | undefined;
      let finishCleanup!: () => void;
      let failCleanup!: (error: unknown) => void;
      const cleanup = new Promise<void>((resolve, reject) => { finishCleanup = resolve; failCleanup = reject; });
      void cleanup.catch(() => {});
      const finish = (error?: Error, result?: WorkflowAuthoringDirectory) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else accept(result!);
        if (!helper) { finishCleanup(); return; }
        void helper.stop(async () => {}).then(() => {
          this.readers.delete(reader!);
          finishCleanup();
        }, failCleanup);
      };
      const timer = setTimeout(() => finish(unavailable()), 5000);
      const source = import.meta.url.endsWith('.ts');
      const entry = fileURLToPath(new URL(source ? './workflow-authoring-scope-reader.ts' : './workflow-authoring-scope-reader.js', import.meta.url));
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
      env.FLOW_WORKFLOW_AUTHORING_SCOPE_READER = '1';
      try {
        helper = (this.options.launch ?? launchWorker)({
          ...(isSea() ? { args: ['--flow-workflow-authoring-scope-reader'] } : { entry, execArgv: source ? ['--experimental-strip-types'] : [] }),
          cwd: '/', env, shutdownTimeoutMs: 0,
        });
        reader = { cancel: () => finish(unavailable()), cleanup };
        this.readers.add(reader);
        helper.child.once('error', () => finish(unavailable()));
        helper.child.once('disconnect', () => finish(unavailable()));
        void helper.exited.then(() => finish(unavailable()));
        helper.child.once('message', (message: unknown) => {
          const response = message as { ok?: unknown; result?: unknown } | null;
          if (!response || response.ok !== true || !validDirectory(response.result)) finish(request.operation === 'check' ? changed() : unavailable());
          else finish(undefined, response.result);
        });
        helper.child.send(request, error => { if (error) finish(unavailable()); });
      } catch { finish(unavailable()); }
    });
  }
}
