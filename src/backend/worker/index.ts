import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { prepareFilesystemIsolation } from "../../isolation/filesystem.ts";
import { createSandbox, sandboxMounts, sandboxUnavailable, type Sandbox, type SandboxSupport } from "../../isolation/sandbox.ts";
import { validateFilesystemScope } from "../../isolation/filesystem.ts";
import { workflowBuilderFolder, type SharedSandbox } from "../../isolation/shared-sandbox.ts";
import type { FilesystemIsolationMode } from "../../protocol/settings.ts";
import { nodeExecutionAssets } from "../../isolation/node-assets.ts";
import type { AgentBackend, BackendCreateOptions, BackendSession, WorkflowSubagentHandle, WorkflowSubagentOptions, PromptAttachment } from "../types.ts";
import type { AgentPermissionMode, BackendEvent, Capabilities, EffortLevel, PermissionDecision, Skill } from "../../protocol/events.ts";
import { launchWorker, workerCommand, type WorkerLaunchOptions } from "./launcher.ts";
import { seaSdkExecutionAssets } from './assets.ts';
import { WorkerRpc } from "./rpc.ts";
import { SandboxMcpSession } from "./sandbox-mcp.ts";
import { mcpMetadata, type SessionSnapshot } from "./protocol.ts";
import { workflowInspectInput, workflowRecoverInput, workflowRelayInput } from "../workflow-tools.ts";
import { migrateLegacyClaudeState, prepareClaudeState, relocateClaudeState } from "./claude-state.ts";
import { relocatePiState } from "../pi/state.ts";
import { recordTiming } from "../../daemon/timings.ts";

export type WorkerBackendOptions = WorkerLaunchOptions & {
  backend?: "pi" | "claude";
  stateRoot?: string;
  /** Trusted test/embedding injection: module exports a default AgentBackend instance. */
  backendModule?: string;
  /** Trusted execution assets hidden by temporary-directory masks, never writable roots. */
  readablePaths?: string[];
  /** Host-resolved launch policy, snapshotted once per Backend Session. Defaults to Bubblewrap. */
  isolationMode?: () => FilesystemIsolationMode;
  /** Host-probed sandbox provider, read when a sandbox-mode Backend Session starts. */
  sandbox?: () => SandboxSupport | undefined;
  /** The VM this worker session owns; Workflow code of the same Agent Session runs in it. */
  sandboxed?: Sandbox;
  /** The host's Shared Sandbox when sandbox sessions share one VM, read when a sandbox-mode Backend Session starts. */
  sharedSandbox?: () => SharedSandbox | undefined;
};

/** One owned worker per Backend Session, optionally enforcing a filesystem boundary. */
export class WorkerBackend implements AgentBackend {
  readonly name: "pi" | "claude";
  private readonly options: WorkerBackendOptions;
  constructor(options: WorkerBackendOptions = {}) { this.options = options; this.name = options.backend ?? "pi"; }
  private async opened(proxy: WorkerSession, signal: AbortSignal | undefined, isolation: FilesystemIsolationMode, begin: number,
    sandbox?: { sharing: "shared" | "own"; remove: number; create: number }): Promise<void> {
    const opening = performance.now();
    const worker = await proxy.open(signal);
    if (!this.options.stateRoot) return;
    const ms = (value = 0) => Math.round(value);
    recordTiming(this.options.stateRoot, { kind: "start", backend: this.name, isolation, ...sandbox, prepare: ms(opening - begin), open: ms(performance.now() - opening),
      worker: { ready: ms(worker?.ready), import: ms(worker?.import), create: ms(worker?.create) } });
  }
  private async createSandboxed(options: BackendCreateOptions): Promise<BackendSession> {
    const begin = performance.now();
    const support = this.options.sandbox?.();
    if (!support?.supported) throw new Error(`${sandboxUnavailable().message}: ${support?.reason ?? "no sandbox provider"}`);
    if (isSea()) throw new Error(`${sandboxUnavailable().message}: single-executable builds cannot run in a sandbox`);
    const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const bundle = this.options.entry ?? join(packageRoot, "build/backend-worker.mjs");
    if (!existsSync(bundle)) throw new Error(`${sandboxUnavailable().message}: worker bundle ${bundle} is missing; run npm run build:worker`);
    const scope = options.workflowBuilder ? realpathSync(options.scope) : validateFilesystemScope({ scope: options.scope, expectedScope: resolve(options.scope),
      ...(this.options.stateRoot ? { stateRoot: this.options.stateRoot } : {}) });
    const shared = this.options.sharedSandbox?.();
    const roots = shared?.roots();
    if (roots && !roots.slice(0, 3).some((root) => scope === root || scope.startsWith(root + sep))) {
      throw new Error(`${sandboxUnavailable().message}: Scope ${scope} is not under the Project Root ${roots[0]}`);
    }
    const temp = options.stateDir ? undefined : realpathSync(mkdtempSync(join(shared ? workflowBuilderFolder() : tmpdir(), "flow-sandbox-")));
    const stateDir = options.stateDir ?? temp!;
    const plan = workerCommand({ ...this.options, entry: bundle });
    const assets = [packageRoot, bundle, ...(this.options.readablePaths ?? [])];
    if (this.options.backendModule) assets.push(fileURLToPath(this.options.backendModule));
    assets.push(...nodeExecutionAssets(assets));
    const env: Record<string, string> = { FLOW_BACKEND_WORKER: "1",
      ...Object.fromEntries(Object.entries(this.options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
    const cleanups: (() => void)[] = [];
    let removed: Promise<unknown> = Promise.resolve();
    if (this.name === "claude") {
      const claude = prepareClaudeState(stateDir, { ...process.env, ...this.options.env }, scope, options.resume,
        { viewRoot: stateDir, secureStorage: support.provider.claudeAuthDir ?? null });
      cleanups.push(claude.cleanup);
      env.CLAUDE_CONFIG_DIR = claude.env.CLAUDE_CONFIG_DIR!;
      if (claude.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = claude.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      env.FLOW_CLAUDE_PATH = support.provider.claudePath;
      for (const entry of readdirSync(env.CLAUDE_CONFIG_DIR)) {
        const link = join(env.CLAUDE_CONFIG_DIR, entry);
        if (!options.workflowBuilder && lstatSync(link).isSymbolicLink() && entry !== "projects") assets.push(realpathSync(link));
      }
    } else {
      const source = this.options.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
      const agent = join(stateDir, "pi-agent");
      rmSync(agent, { recursive: true, force: true });
      mkdirSync(agent, { recursive: true, mode: 0o700 });
      cleanups.push(() => rmSync(agent, { recursive: true, force: true }));
      for (const name of ["auth.json", "models.json", "settings.json"]) {
        if (existsSync(join(source, name))) copyFileSync(join(source, name), join(agent, name));
      }
      // Keep user resources live and read-only, including Git-managed trees reached through
      // symlinks. Link to the canonical target so the guest needs no host-side link ancestors.
      if (!options.workflowBuilder) for (const name of ["AGENTS.md", "skills", "prompts"]) {
        const from = join(source, name);
        if (!existsSync(from)) continue;
        const target = realpathSync(from);
        symlinkSync(target, join(agent, name), statSync(target).isDirectory() ? "dir" : "file");
        assets.push(target);
      }
      env.PI_CODING_AGENT_DIR = agent;
      env.PI_CODING_AGENT_SESSION_DIR = join(stateDir, "sessions");
    }
    const cleanup = () => {
      for (const step of cleanups.splice(0)) step();
      if (temp) void removed.then(() => rmSync(temp, { recursive: true, force: true }));
    };
    let proxy: WorkerSession | undefined;
    try {
      const auth = support.provider.claudeAuthDir && (shared || this.name === "claude") ? [support.provider.claudeAuthDir] : [];
      const mounts = sandboxMounts([...roots ?? [scope, stateDir], ...auth], assets);
      let sandbox: Sandbox, startup: Sandbox["startup"];
      if (shared) {
        const acquired = await shared.acquire(support.provider, roots![0]!, mounts, options.signal, options.evict);
        ({ sandbox, startup } = acquired);
        cleanups.push(acquired.release);
      } else {
        sandbox = await createSandbox(support.provider, { name: `flow-${createHash("sha256").update(stateDir).digest("hex").slice(0, 16)}`,
          workspace: scope, mounts, env: {} }, join(stateDir, "sandbox.json"), options.signal);
        ({ startup } = sandbox);
        cleanups.push(() => { removed = sandbox.close().catch((error: unknown) => console.error(`Sandbox ${sandbox.name} removal failed: ${(error as Error).message}`)); });
      }
      const launch = sandbox.command(scope, [support.provider.nodePath, ...plan.args], env);
      proxy = new WorkerSession({ ...options, scope, stateDir }, { ...this.options, sandboxed: sandbox, startupTimeoutMs: this.options.startupTimeoutMs ?? 300_000, command: launch.command, args: launch.args, env: {} }, cleanup);
      await this.opened(proxy, options.signal, "sandbox", begin, { sharing: shared ? "shared" : "own", remove: Math.round(startup.remove), create: Math.round(startup.create) });
      return proxy;
    } catch (error) {
      if (proxy) await proxy.dispose(); else cleanup();
      throw error;
    }
  }

  relocate(stateDir: string, from: string, to: string): void {
    if (this.name === "claude") relocateClaudeState(stateDir, from, to);
    else relocatePiState(stateDir, from, to);
  }

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    const begin = performance.now();
    options.signal?.throwIfAborted();
    const isolationMode = this.options.isolationMode?.() ?? "bubblewrap";
    if (isolationMode === "sandbox") return this.createSandboxed(options);
    if (isolationMode === "none") {
      const scope = realpathSync(options.scope);
      if (!statSync(scope).isDirectory()) throw new Error("Scope must be a directory");
      // Pi retains its ordinary full environment. Claude needs an owned projects tree in both
      // modes; prepare its private config view on the host so Workflow children inherit it too.
      const claude = this.name === "claude" ? prepareClaudeState(options.stateDir, { ...process.env, ...this.options.env }, scope, options.resume) : undefined;
      let proxy: WorkerSession | undefined;
      try {
        proxy = new WorkerSession({ ...options, scope },
          claude ? { ...this.options, env: claude.env } : this.options, claude?.cleanup ?? (() => {}));
        await this.opened(proxy, options.signal, "none", begin); return proxy;
      } catch (error) {
        if (proxy) await proxy.dispose(); else claude?.cleanup();
        throw error;
      }
    }
    const plan = workerCommand(this.options);
    const packageRoot = isSea() ? dirname(process.execPath) : fileURLToPath(new URL("../../..", import.meta.url));
    const assets = [packageRoot, ...(this.options.readablePaths ?? [])];
    if (isSea()) assets.push(...seaSdkExecutionAssets());
    if (this.options.backendModule) assets.push(fileURLToPath(this.options.backendModule));
    if (this.options.entry) {
      assets.push(this.options.entry);
      if (dirname(this.options.entry).endsWith("/backend/worker")) assets.push(resolve(dirname(this.options.entry), "../../.."));
    }
    // Both npm workers and SEAs can resolve hoisted or linked dependencies outside the
    // package root. Restore only those trees/targets; the policy validates all mounts.
    assets.push(...nodeExecutionAssets(assets));
    const isolation = await prepareFilesystemIsolation({ ...plan, scope: options.scope, expectedScope: resolve(options.scope),
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(this.options.stateRoot ? { stateRoot: this.options.stateRoot } : {}),
      env: this.options.env ?? {}, credentials: this.name, workflowBuilder: !!options.workflowBuilder, worker: true, readablePaths: assets });
    let proxy: WorkerSession | undefined;
    try {
      options.signal?.throwIfAborted();
      if (this.name === "claude") migrateLegacyClaudeState(options.stateDir,
        { ...process.env, ...this.options.env }, isolation.scope, options.resume);
      proxy = new WorkerSession({ ...options, scope: isolation.scope, stateDir: isolation.stateDir },
        { ...this.options, command: isolation.command, args: isolation.args, env: isolation.env, stdioFds: isolation.stdioFds }, isolation.cleanup);
      await this.opened(proxy, options.signal, "bubblewrap", begin);
      return proxy;
    } catch (error) {
      if (proxy) await proxy.dispose(); else isolation.cleanup();
      throw error;
    }
  }
}

class WorkerSession implements BackendSession {
  capabilities!: Capabilities;
  get sandbox(): Sandbox | undefined { return this.launchOptions.sandboxed; }
  private resume: string | undefined;
  private readonly worker: ReturnType<typeof launchWorker>;
  private readonly rpc: WorkerRpc;
  private failed: Error | undefined;
  private disposing = false;
  private disposal: Promise<void> | undefined;
  private readonly workflows = new Map<string, {
    emit: WorkflowSubagentOptions["emit"];
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }>();
  refreshMcp?: () => Promise<void>;
  startWorkflowSubagent?: (options: WorkflowSubagentOptions) => WorkflowSubagentHandle;
  compact?: (instructions?: string) => Promise<void>;
  skills?: () => Promise<Skill[]>;
  answerEnquiry?: (askId: string, answers: string[][]) => Promise<boolean>;
  answerPermission?: (callId: string, decision: PermissionDecision) => Promise<boolean>;
  setPermissionMode?: (mode: AgentPermissionMode) => Promise<void>;

  private readonly options: BackendCreateOptions;
  private readonly launchOptions: WorkerBackendOptions;
  private readonly cleanup: () => void;
  constructor(options: BackendCreateOptions, launchOptions: WorkerBackendOptions, cleanup: () => void) {
    this.cleanup = cleanup;
    this.options = options;
    this.launchOptions = launchOptions;
    this.worker = launchWorker(launchOptions);
    const child = this.worker.child;
    this.rpc = new WorkerRpc((message) => {
      this.worker.send(message, (error) => { if (error) this.fail(error); });
    }, async (method, args, signal) => {
      if (this.disposing || this.failed) throw new Error("Backend Session stopped");
      // Builders never inherit other host capabilities, even if the worker asks directly.
      if (this.options.workflowBuilder && !["workflowBuilder.read", "workflowBuilder.list", "workflowBuilder.write"].includes(method)) {
        throw new Error("Host capability is not enabled for workflow builder");
      }
      // Never look up host functions by a worker-supplied property name.
      switch (method) {
        case "mcp.token": {
          if (!(this.options.mcp instanceof SandboxMcpSession) || typeof args[0] !== "string") throw new Error("Host capability is not enabled");
          return this.options.mcp.token(args[0], args[1] === true);
        }
        case "workflowBuilder.read": return this.requireWorkflowBuilder(args[0]).read(args[0] as string);
        case "workflowBuilder.list": return this.requireWorkflowBuilder(args[0]).list(args[0] as string);
        case "workflowBuilder.write": return this.requireWorkflowBuilder(args[0]).write(args[0] as string);
        case "mcp.call": {
          const tool = this.options.mcp?.tools().find((tool) => tool.name === args[0]);
          if (!tool) throw new Error("Unknown MCP tool");
          const input = args[1];
          const timeout = args[2];
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid MCP input");
          if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) throw new Error("Invalid MCP timeout");
          return tool.call(input as Record<string, unknown>, signal, timeout as number | undefined);
        }
        case "workflow.inspect": return this.requireWorkflow().inspect(workflowInspectInput.parse(args[0]));
        case "workflow.recover": return this.requireWorkflow().recover(workflowRecoverInput.parse(args[0]), signal);
        case "workflow.relayEnquiry": return this.requireWorkflow().relayEnquiry(workflowRelayInput.parse(args[0]), signal);
        case "workflow.relayPermission": return this.requireWorkflow().relayPermission(workflowRelayInput.parse(args[0]), signal);
        default: throw new Error(`Unknown host method: ${method}`);
      }
    }, (name, value) => this.notify(name, value));
    this.worker.onMessage((message) => this.rpc.receive(message), (error) => this.fail(error));
    child.once("error", (error) => this.fail(error));
    child.stdout?.once("close", () => this.fail(new Error("Backend worker disconnected")));
    child.once("exit", (code, signal) => this.fail(new Error(`Backend worker exited (${signal ?? code ?? "unknown"})${this.worker.diagnostics() ? `: ${this.worker.diagnostics()}` : ""}`)));
  }

  private requireWorkflowBuilder(input: unknown) {
    if (!this.options.workflowBuilder) throw new Error("Workflow builder tools are not enabled");
    if (typeof input !== "string") throw new Error("Invalid workflow builder input: expected a string");
    return this.options.workflowBuilder;
  }

  private requireWorkflow() {
    if (!this.options.workflow) throw new Error("Workflow tools are not enabled");
    return this.options.workflow;
  }

  async open(signal?: AbortSignal): Promise<SessionSnapshot["startup"]> {
    const { emit: _emit, onFailure: _onFailure, signal: _signal, evict: _evict, mcp, workflow, workflowBuilder, ...options } = this.options;
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), this.launchOptions.startupTimeoutMs ?? 60_000);
    try {
      const state = await this.rpc.call<SessionSnapshot>("create", [{ ...options, backend: this.launchOptions.backend ?? "pi",
        workflowEnabled: !workflowBuilder && !!workflow,
        ...(workflowBuilder ? { workflowBuilderInstructions: workflowBuilder.instructions }
          : mcp instanceof SandboxMcpSession ? { mcpSandbox: mcp.definitions() }
          : mcp ? { mcpTools: mcpMetadata(mcp), mcpConnectionIds: (mcp.connections ?? []).map((connection) => connection.id) } : {}),
        ...(this.launchOptions.backendModule ? { backendModule: this.launchOptions.backendModule } : {}),
      }], controller.signal);
      this.updateSnapshot(state);
      if (mcp instanceof SandboxMcpSession) mcp.attach((method, args, signal) => this.rpc.call(method, args, signal));
      const methods = new Set(state.methods);
      if (!workflowBuilder && methods.has("refreshMcp")) this.refreshMcp = () => this.rpc.call("refreshMcp", [mcpMetadata(this.options.mcp)]);
      if (methods.has("compact")) this.compact = (instructions) => this.rpc.call("compact", [instructions]);
      if (methods.has("skills")) this.skills = () => this.rpc.call("skills");
      if (methods.has("answerEnquiry")) this.answerEnquiry = (id, answers) => this.rpc.call("answerEnquiry", [id, answers]);
      if (methods.has("answerPermission")) this.answerPermission = (id, decision) => this.rpc.call("answerPermission", [id, decision]);
      if (methods.has("setPermissionMode")) this.setPermissionMode = (mode) => this.rpc.call("setPermissionMode", [mode]);
      if (!workflowBuilder && methods.has("startWorkflowSubagent")) this.startWorkflowSubagent = (options) => this.startWorkflow(options);
      return state.startup;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  private updateSnapshot(state: SessionSnapshot) {
    this.capabilities = state.capabilities;
    this.resume = state.resume;
  }
  private notify(name: string, value: unknown) {
    switch (name) {
      case "snapshot": this.updateSnapshot(value as SessionSnapshot); break;
      case "event": {
        const { event, snapshot } = value as { event: BackendEvent; snapshot?: SessionSnapshot };
        if (snapshot) this.updateSnapshot(snapshot);
        if (event.type === "capabilities_changed") this.capabilities = event.capabilities;
        this.options.emit(event);
        break;
      }
      case "workflow.event": {
        const { id, activity } = value as { id: string; activity: Parameters<WorkflowSubagentOptions["emit"]>[0] };
        this.workflows.get(id)?.emit(activity);
        break;
      }
      case "workflow.done": {
        const { id, value: result, error } = value as { id: string; value: string; error?: string };
        const handle = this.workflows.get(id);
        this.workflows.delete(id);
        if (error !== undefined) handle?.reject(new Error(error));
        else handle?.resolve(result);
        break;
      }
    }
  }

  private startWorkflow(options: WorkflowSubagentOptions): WorkflowSubagentHandle {
    if (this.failed || this.disposing) throw this.failed ?? new Error("Backend Session stopped");
    const id = randomUUID();
    const { emit, ...metadata } = options;
    const done = new Promise<string>((resolve, reject) => { this.workflows.set(id, { emit, resolve, reject }); });
    // A caller may attach its rejection handler after the synchronous handle has returned.
    void done.catch(() => {});
    const started = this.rpc.call("workflow.start", [id, metadata]);
    void started.catch((error: Error) => { this.workflows.get(id)?.reject(error); this.workflows.delete(id); });
    return {
      done,
      answerEnquiry: async (askId, answers) => { await started; return this.rpc.call("workflow.answerEnquiry", [id, askId, answers]); },
      answerPermission: async (callId, decision) => { await started; return this.rpc.call("workflow.answerPermission", [id, callId, decision]); },
      cancel: async () => { await started; await this.rpc.call("workflow.cancel", [id]); },
    };
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    this.rpc.close(error);
    for (const handle of this.workflows.values()) handle.reject(error);
    this.workflows.clear();
    // A backend loss interrupts workflow work. Do not replay commands or start a replacement.
    if (!this.disposing) {
      this.options.emit({ type: "notice", level: "error", text: error.message });
      this.options.onFailure?.(error);
    }
    void this.worker.stop(async () => {}).then(this.cleanup).catch(() => {});
  }
  resumeToken() { return this.resume; }
  prompt(text: string, attachments?: PromptAttachment[]) { return this.rpc.call<void>("prompt", [text, attachments]); }
  abort() { return this.rpc.call<void>("abort"); }
  setModel(modelId: string) { return this.rpc.call<void>("setModel", [modelId]); }
  setEffort(effort: EffortLevel) { return this.rpc.call<void>("setEffort", [effort]); }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposing = true;
      try { await this.worker.stop(() => this.rpc.call("dispose")); }
      finally { this.fail(new Error("Backend Session stopped")); this.cleanup(); }
    })();
  }
}
