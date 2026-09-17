import { spawn } from "node:child_process";
import { query, type Options, type Query, type SDKUserMessage, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { BackendEvent, PermissionDecision } from "../../protocol/events.ts";
import type { ModelAutoCompaction } from "../../protocol/settings.ts";
import type { WorkflowSubagentHandle, WorkflowSubagentOptions } from "../types.ts";
import { AsyncQueue } from "./async-queue.ts";
import { PendingEnquiries, ASK_TOOL, questionsOf } from "./enquiries.ts";
import { PendingPermissions, type Settle } from "./permissions.ts";
import { describeCompaction, describeSpend } from "./index.ts";
import { claudeAutoCompactionEnv } from "./auto-compaction.ts";
import { WorkflowProcesses } from "./workflow-processes.ts";

export type WorkflowQueryDependencies = {
  query?: typeof query;
  spawn?: (options: SpawnOptions) => { process: SpawnedProcess; stopped: Promise<void> };
};

export class ClaudeWorkflowSubagent implements WorkflowSubagentHandle {
  readonly done: Promise<string>;
  private readonly controller = new AbortController();
  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly enquiries = new PendingEnquiries();
  private readonly permissions = new PendingPermissions();
  private readonly grants: Set<string>;
  private readonly work: WorkflowProcesses;
  private readonly processes: { process: SpawnedProcess; stopped: Promise<void> }[] = [];
  private stream: Query | undefined;
  private stopping = false;
  private readonly options: WorkflowSubagentOptions;

  private readonly launch: Pick<Options, "cwd" | "pathToClaudeCodeExecutable" | "disallowedTools" | "mcpServers">;
  private readonly dependencies: WorkflowQueryDependencies;
  private readonly autoCompaction: ModelAutoCompaction;

  constructor(launch: Pick<Options, "cwd" | "pathToClaudeCodeExecutable" | "disallowedTools" | "mcpServers">,
    options: WorkflowSubagentOptions, grants: Set<string>,
    dependencies: WorkflowQueryDependencies = {}, autoCompaction: ModelAutoCompaction = {}) {
    this.launch = launch;
    this.dependencies = dependencies;
    this.options = { ...options, input: structuredClone(options.input) };
    this.autoCompaction = autoCompaction;
    this.grants = grants;
    this.work = new WorkflowProcesses(launch.cwd!, (event) => this.emit(event));
    this.done = Promise.resolve().then(() => this.run());
    void this.done.catch(() => {});
  }

  private emit(event: BackendEvent): void {
    this.options.emit({ subagentId: this.options.id, event });
  }

  async answerEnquiry(id: string, answers: string[][]): Promise<boolean> {
    const questions = this.enquiries.describe(id);
    if (!questions || !this.enquiries.answer(id, answers)) return false;
    this.emit({ type: "enquiry", askId: id, questions, state: "answered", answers });
    return true;
  }

  async answerPermission(id: string, decision: PermissionDecision): Promise<boolean> {
    const tool = this.permissions.describe(id);
    if (!tool || !this.permissions.decide(id, decision)) return false;
    if (decision === "always") this.grants.add(tool);
    this.emit({ type: "permission", callId: id, tool, state: "decided", decision });
    return true;
  }

  private abandon(): void {
    for (const { askId, questions } of this.enquiries.abandonAll("the workflow step stopped")) {
      this.emit({ type: "enquiry", askId, questions, state: "aborted" });
    }
    for (const { callId, tool } of this.permissions.abandonAll("the workflow step stopped")) {
      this.emit({ type: "permission", callId, tool, state: "aborted" });
    }
  }

  async cancel(): Promise<void> {
    this.stopping = true;
    this.abandon();
    this.controller.abort();
    this.inbox.close();
    try { this.stream?.close(); }
    finally { await Promise.all([this.work.dispose(), this.done.catch(() => {})]); }
  }

  private async authorise(id: string, tool: string, input: Record<string, unknown>): Promise<Parameters<Settle>[0]> {
    if (this.controller.signal.aborted || this.stopping) return { behavior: "deny", message: "Workflow step stopped" };
    if (this.launch.disallowedTools?.includes(tool)) return { behavior: "deny", message: "Tool disabled by the Backend Adapter" };
    if (tool === ASK_TOOL) {
      const questions = questionsOf(input);
      if (!questions.length) return { behavior: "deny", message: "No questions supplied" };
      return new Promise((resolve) => {
        this.enquiries.hold(id, questions, input, resolve);
        this.emit({ type: "enquiry", askId: id, questions, state: "asked" });
      });
    }
    if (this.options.permissionMode === "auto-accept" || this.grants.has(tool)) return { behavior: "allow", updatedInput: input };
    if (this.permissions.isRefused(tool)) return { behavior: "deny", message: "Tool permission refused" };
    return new Promise((resolve) => {
      this.permissions.hold(id, tool, input, resolve);
      this.emit({ type: "permission", callId: id, tool, state: "asked" });
    });
  }

  private async run(): Promise<string> {
    const { options, controller } = this;
    try {
      controller.signal.throwIfAborted();
      if (!["ask", "auto-accept"].includes(options.permissionMode)) throw new Error("Unsupported workflow permission mode");
      if (options.effort === "minimal") throw new Error(`Unsupported workflow Effort: ${options.effort}`);
      const compactionEnv = claudeAutoCompactionEnv(this.autoCompaction[options.modelId]) ?? process.env;
      const stream = (this.dependencies.query ?? query)({ prompt: this.inbox, options: {
        ...this.launch, model: options.modelId,
        ...(options.effort === "off" ? {} : { effort: options.effort }),
        systemPrompt: `${options.instructions}\n\nReturn only JSON. Use workflow shell tools for commands; do not detach processes or delegate work.`,
        persistSession: false, settingSources: [], skills: [], strictMcpConfig: true,
        tools: ["Read", "Write", "Edit", "Glob", "Grep", "AskUserQuestion"],
        disallowedTools: ["Agent", "Task", "Bash", "BashOutput", "KillShell", "TaskOutput", "TaskStop", "Monitor", "Skill", ...(this.launch.disallowedTools ?? [])],
        mcpServers: { ...this.launch.mcpServers, workflow: this.work.server }, permissionMode: "default", allowedTools: [],
        abortController: controller,
        env: { ...compactionEnv, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
          CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1", CLAUDE_CODE_EFFORT_LEVEL: undefined },
        hooks: { PreToolUse: [{ hooks: [async () => ({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
        })] }] },
        canUseTool: async (tool, input, extra) => this.authorise(extra.toolUseID, tool,
          tool === "mcp__workflow__bash" ? { ...input, call_id: extra.toolUseID } : input),
        spawnClaudeCodeProcess: (spawnOptions) => {
          if (this.stopping || controller.signal.aborted) throw new Error("Workflow step stopped before process startup");
          const owned = this.dependencies.spawn ? this.dependencies.spawn(spawnOptions) : spawnWorkflowProcess(spawnOptions);
          this.processes.push(owned);
          return owned.process;
        },
      } });
      this.stream = stream;
      const models = await stream.supportedModels();
      controller.signal.throwIfAborted();
      const model = models.find((model) => model.value === options.modelId);
      if (!model) throw new Error(`Unknown workflow model: ${options.modelId}`);
      const levels = model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [];
      if (levels.length ? !levels.includes(options.effort as (typeof levels)[number]) : options.effort !== "off") {
        throw new Error(`Unsupported workflow Effort: ${options.effort}`);
      }
      this.inbox.push({ type: "user", session_id: "", parent_tool_use_id: null,
        message: { role: "user", content: JSON.stringify(options.input) } });
      for await (const message of stream) {
        controller.signal.throwIfAborted();
        // Claude exposes automatic compaction only after the boundary has landed. Record that
        // truthful completion and continue consuming the same query until its schema-valid result.
        if (message.type === "system" && message.subtype === "compact_boundary") {
          this.emit(describeCompaction(message.compact_metadata));
        }
        if (message.type === "assistant") {
          const text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
          if (text) this.emit({ type: "message", id: message.uuid, text, final: true });
          for (const block of message.message.content) {
            if (block.type === "tool_use") this.emit({ type: "tool_started", callId: block.id, name: block.name, input: block.input });
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === "tool_result") this.emit({ type: "tool_ended", callId: block.tool_use_id, result: block.content, isError: block.is_error === true });
          }
        }
        if (message.type === "result") {
          const spend = describeSpend(message);
          if (spend) options.emit({ subagentId: options.id, event: { type: "spend", spend } });
          if (message.subtype !== "success") throw new Error(`Workflow Subagent ${message.subtype}: ${message.errors.join("; ")}`);
          this.abandon();
          await this.work.drain();
          controller.signal.throwIfAborted();
          return message.result;
        }
      }
      throw new Error("Claude workflow query ended without a result");
    } finally {
      this.stopping = true;
      this.abandon();
      this.inbox.close();
      await this.work.dispose();
      try { this.stream?.close(); }
      finally {
        await Promise.all(this.processes.map(async (owned) => {
          const timer = setTimeout(() => owned.process.kill("SIGKILL"), 2500);
          try { await owned.stopped; } finally { clearTimeout(timer); }
        }));
      }
    }
  }
}

export function spawnWorkflowProcess(options: SpawnOptions): { process: SpawnedProcess; stopped: Promise<void> } {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
    signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  return { process: child as unknown as SpawnedProcess,
    stopped: new Promise((resolve) => child.once("close", () => resolve())) };
}
