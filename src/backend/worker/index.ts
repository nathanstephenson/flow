import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { prepareFilesystemIsolation } from "../../isolation/filesystem.ts";
import { nodeExecutionAssets } from "../../isolation/node-assets.ts";
import type { AgentBackend, BackendCreateOptions, BackendSession, WorkflowSubagentHandle, WorkflowSubagentOptions, PromptAttachment } from "../types.ts";
import type { AgentPermissionMode, BackendEvent, Capabilities, EffortLevel, PermissionDecision, Skill } from "../../protocol/events.ts";
import { launchWorker, workerCommand, type WorkerLaunchOptions } from "./launcher.ts";
import { seaSdkExecutionAssets } from './assets.ts';
import { WorkerRpc } from "./rpc.ts";
import { mcpMetadata, type SessionSnapshot } from "./protocol.ts";
import { workflowInspectInput, workflowRecoverInput, workflowRelayInput } from "../workflow-tools.ts";
import { migrateLegacyClaudeState, prepareClaudeState } from "./claude-state.ts";

export type WorkerBackendOptions = WorkerLaunchOptions & {
  backend?: "pi" | "claude";
  stateRoot?: string;
  /** Trusted test/embedding injection: module exports a default AgentBackend instance. */
  backendModule?: string;
  /** Trusted execution assets hidden by temporary-directory masks, never writable roots. */
  readablePaths?: string[];
  /** Host-resolved launch policy, snapshotted once per Backend Session. Defaults to restricted. */
  isolationEnabled?: () => boolean;
};

/** One owned worker per Backend Session, optionally enforcing a filesystem boundary. */
export class WorkerBackend implements AgentBackend {
  readonly name: "pi" | "claude";
  private readonly options: WorkerBackendOptions;
  constructor(options: WorkerBackendOptions = {}) { this.options = options; this.name = options.backend ?? "pi"; }
  async create(options: BackendCreateOptions): Promise<BackendSession> {
    const isolationEnabled = this.options.isolationEnabled?.() ?? true;
    if (!isolationEnabled) {
      const scope = realpathSync(options.scope);
      if (!statSync(scope).isDirectory()) throw new Error("Scope must be a directory");
      // Pi retains its ordinary full environment. Claude needs an owned projects tree in both
      // modes; prepare its private config view on the host so Workflow children inherit it too.
      const claude = this.name === "claude" ? prepareClaudeState(options.stateDir, { ...process.env, ...this.options.env }, scope, options.resume) : undefined;
      let proxy: WorkerSession | undefined;
      try {
        proxy = new WorkerSession({ ...options, scope },
          claude ? { ...this.options, env: claude.env } : this.options, claude?.cleanup ?? (() => {}));
        await proxy.open(); return proxy;
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
      env: this.options.env ?? {}, credentials: this.name, ipc: true, readablePaths: assets });
    let proxy: WorkerSession | undefined;
    try {
      if (this.name === "claude") migrateLegacyClaudeState(options.stateDir,
        { ...process.env, ...this.options.env }, isolation.scope, options.resume);
      proxy = new WorkerSession({ ...options, scope: isolation.scope, stateDir: isolation.stateDir },
        { ...this.options, command: isolation.command, args: isolation.args, env: isolation.env, stdioFds: isolation.stdioFds }, isolation.cleanup);
      await proxy.open();
      return proxy;
    } catch (error) {
      if (proxy) await proxy.dispose(); else isolation.cleanup();
      throw error;
    }
  }
}

class WorkerSession implements BackendSession {
  capabilities!: Capabilities;
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
      if (!child.connected) throw new Error("Backend worker disconnected");
      child.send(message, (error) => { if (error) this.fail(error); });
    }, async (method, args, signal) => {
      if (this.disposing || this.failed) throw new Error("Backend Session stopped");
      // Never look up host functions by a worker-supplied property name.
      switch (method) {
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
    child.on("message", (message) => this.rpc.receive(message));
    child.once("error", (error) => this.fail(error));
    child.once("disconnect", () => this.fail(new Error("Backend worker disconnected")));
    child.once("exit", (code, signal) => this.fail(new Error(`Backend worker exited (${signal ?? code ?? "unknown"})${this.worker.diagnostics() ? `: ${this.worker.diagnostics()}` : ""}`)));
  }

  private requireWorkflow() {
    if (!this.options.workflow) throw new Error("Workflow tools are not enabled");
    return this.options.workflow;
  }

  async open(): Promise<void> {
    const { emit: _emit, onFailure: _onFailure, mcp, workflow, ...options } = this.options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.launchOptions.startupTimeoutMs ?? 60_000);
    try {
      const state = await this.rpc.call<SessionSnapshot>("create", [{ ...options, backend: this.launchOptions.backend ?? "pi",
        workflowEnabled: !!workflow,
        ...(mcp ? { mcpTools: mcpMetadata(mcp) } : {}),
        ...(this.launchOptions.backendModule ? { backendModule: this.launchOptions.backendModule } : {}),
      }], controller.signal);
      this.updateSnapshot(state);
      const methods = new Set(state.methods);
      if (methods.has("refreshMcp")) this.refreshMcp = () => this.rpc.call("refreshMcp", [mcpMetadata(this.options.mcp)]);
      if (methods.has("compact")) this.compact = (instructions) => this.rpc.call("compact", [instructions]);
      if (methods.has("skills")) this.skills = () => this.rpc.call("skills");
      if (methods.has("answerEnquiry")) this.answerEnquiry = (id, answers) => this.rpc.call("answerEnquiry", [id, answers]);
      if (methods.has("answerPermission")) this.answerPermission = (id, decision) => this.rpc.call("answerPermission", [id, decision]);
      if (methods.has("setPermissionMode")) this.setPermissionMode = (mode) => this.rpc.call("setPermissionMode", [mode]);
      if (methods.has("startWorkflowSubagent")) this.startWorkflowSubagent = (options) => this.startWorkflow(options);
    } finally { clearTimeout(timer); }
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
