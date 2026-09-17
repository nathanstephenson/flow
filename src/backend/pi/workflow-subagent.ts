import { piMcpTools } from "./mcp.ts";
import type { McpSession } from "../mcp.ts";
import {
  createAgentSession, DefaultPackageManager, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
  type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { BackendEvent, PermissionDecision } from "../../protocol/events.ts";
import type { WorkflowSubagentHandle, WorkflowSubagentOptions } from "../types.ts";
import { PiSession } from "./index.ts";
import { PiEnquiries } from "./enquiries.ts";
import { backgroundTools } from "./background-calls.ts";
import { PiWork } from "./work.ts";

export class PiWorkflowSubagent implements WorkflowSubagentHandle {
  readonly done: Promise<string>;
  private readonly controller = new AbortController();
  private readonly enquiries: PiEnquiries;
  private readonly work: PiWork;
  private child: AgentSession | undefined;
  private readonly grants: Set<string>;
  private readonly permissions = new Map<string, (decision?: PermissionDecision) => void>();
  private readonly options: WorkflowSubagentOptions;

  private readonly mcp: McpSession | undefined;
  constructor(parent: AgentSession, options: WorkflowSubagentOptions, grants: readonly string[], mcp?: McpSession) {
    this.mcp = mcp;
    this.options = { ...options, input: structuredClone(options.input) };
    this.grants = new Set(grants);
    this.enquiries = new PiEnquiries((event) => this.emit(event));
    this.work = new PiWork((event) => this.emit(event), () => {});
    this.done = Promise.resolve().then(() => this.run(parent));
    void this.done.catch(() => {});
  }

  private emit(event: BackendEvent): void {
    this.options.emit({ subagentId: this.options.id, event });
  }

  async answerEnquiry(id: string, answers: string[][]): Promise<boolean> {
    return this.enquiries.answer(id, answers);
  }

  async answerPermission(id: string, decision: PermissionDecision): Promise<boolean> {
    const resolve = this.permissions.get(id);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  async cancel(): Promise<void> {
    this.controller.abort();
    for (const resolve of this.permissions.values()) resolve();
    await Promise.all([this.child?.abort(), this.work.dispose(), this.done.catch(() => {})]);
  }

  private wrap(tool: ToolDefinition): ToolDefinition {
    return { ...tool, execute: async (id, input, signal, update, context) => {
      this.controller.signal.throwIfAborted();
      if (this.options.permissionMode === "ask" && !this.grants.has(tool.name)) {
        const decision = await new Promise<PermissionDecision | undefined>((resolve) => {
          const abort = () => finish();
          const finish = (decision?: PermissionDecision) => {
            this.permissions.delete(id);
            signal?.removeEventListener("abort", abort);
            if (decision === "always") this.grants.add(tool.name);
            this.emit(decision ? { type: "permission", callId: id, tool: tool.name, state: "decided", decision }
              : { type: "permission", callId: id, tool: tool.name, state: "aborted" });
            resolve(decision);
          };
          this.permissions.set(id, finish);
          signal?.addEventListener("abort", abort, { once: true });
          this.emit({ type: "permission", callId: id, tool: tool.name, state: "asked" });
          if (signal?.aborted) finish();
        });
        if (!decision || decision === "deny") throw new Error("Tool permission refused");
      }
      this.controller.signal.throwIfAborted();
      return tool.execute(id, input, signal, update, context);
    } };
  }

  private async run(parent: AgentSession): Promise<string> {
    const { options, controller } = this;
    let adapter: PiSession | undefined;
    try {
      controller.signal.throwIfAborted();
      const model = parent.modelRuntime.getAvailableSnapshot().find((model) => `${model.provider}/${model.id}` === options.modelId);
      if (!model) throw new Error(`Unknown workflow model: ${options.modelId}`);
      if (!["ask", "auto-accept"].includes(options.permissionMode)) throw new Error("Unsupported workflow permission mode");
      const scope = parent.sessionManager.getCwd();
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const skillContext = options.skill
        ? `The leading Skill invocation is expanded as the user prompt. Follow it together with the mapped workflow input below.\n\nMapped workflow input (JSON):\n${JSON.stringify(options.input)}\n\nWorkflow constraints:${options.instructions.slice(options.skill.invocation.length)}`
        : options.instructions;
      const resources = options.skill ? await new DefaultPackageManager({ cwd: scope, agentDir: getAgentDir(),
        settingsManager: SettingsManager.create(scope, getAgentDir()),
      }).resolve(async () => "skip") : undefined;
      const resourceLoader = new DefaultResourceLoader({ cwd: scope, agentDir: getAgentDir(), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalSkillPaths: resources?.skills.filter(resource => resource.enabled).map(resource => resource.path) ?? [],
        additionalPromptTemplatePaths: resources?.prompts.filter(resource => resource.enabled).map(resource => resource.path) ?? [],
        ...(options.skill ? {
          skillsOverride: (base) => ({ ...base, skills: base.skills.filter(skill => skill.name === options.skill!.name) }),
          promptsOverride: (base) => ({ ...base, prompts: base.prompts.filter(prompt => prompt.name === options.skill!.name) }),
        } : {}),
        agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPromptOverride: () => [],
        systemPromptOverride: () => `You are workflow Subagent ${options.name}. Return only JSON. You cannot create Subagents.\n\n${skillContext}`,
      });
      try { await resourceLoader.reload(); }
      catch (error) {
        if (options.skill) throw new Error(`Could not resolve Skill /${options.skill.name} in the execution Scope: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      controller.signal.throwIfAborted();
      let prompt = JSON.stringify(options.input);
      if (options.skill) {
        const promptTemplate = resourceLoader.getPrompts().prompts.some(candidate => candidate.name === options.skill!.name);
        const skill = resourceLoader.getSkills().skills.some(candidate => candidate.name === options.skill!.name);
        if (!promptTemplate && !skill) {
          throw new Error(`Skill /${options.skill.name} is unavailable in the execution Scope. Restore it or select another Skill before retrying.`);
        }
        prompt = promptTemplate
          ? options.skill.invocation
          : `/skill:${options.skill.name} ${options.skill.invocation.slice(options.skill.name.length + 1)}`;
      }
      const names = [...parent.getActiveToolNames(), ...piMcpTools(this.mcp).map((tool) => tool.name)].filter((name) => name !== "subagent");
      const definitions = [...piMcpTools(this.mcp), createReadToolDefinition(scope), createEditToolDefinition(scope), createWriteToolDefinition(scope),
        createGrepToolDefinition(scope), createFindToolDefinition(scope), createLsToolDefinition(scope), createPowerShellToolDefinition(scope),
        ...backgroundTools(scope, settingsManager, this.work, undefined, false, true)];
      const customTools = definitions.filter((tool) => names.includes(tool.name)).map((tool) => this.wrap(tool as ToolDefinition));
      customTools.push(this.enquiries.tool);
      const { session } = await createAgentSession({ cwd: scope, model, modelRuntime: parent.modelRuntime,
        resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(scope),
        tools: customTools.map((tool) => tool.name), customTools,
      });
      this.child = session;
      controller.signal.throwIfAborted();
      if (!session.getAvailableThinkingLevels().includes(options.effort as AgentSession["thinkingLevel"])) {
        throw new Error(`Unsupported workflow Effort: ${options.effort}`);
      }
      session.setThinkingLevel(options.effort as AgentSession["thinkingLevel"]);
      let output = "";
      let failure: string | undefined;
      adapter = new PiSession(session, (event) => {
        if (event.type === "turn_ended") {
          if (event.reason !== "complete") failure ??= `Workflow Subagent ${event.reason}`;
          return;
        }
        if (event.type === "turn_started" || event.type === "context_usage") return;
        if (event.type === "message" && event.final) output = event.text;
        if (event.type === "notice" && event.level === "error") failure = event.text;
        this.emit(event);
      });
      await adapter.prompt(prompt);
      controller.signal.throwIfAborted();
      if (failure) throw new Error(failure);
      await this.work.drain();
      controller.signal.throwIfAborted();
      return output;
    } finally {
      await this.work.dispose();
      if (this.child) {
        const stats = this.child.getSessionStats();
        const model = { id: options.modelId, tokens: stats.tokens.total,
          cached: stats.tokens.cacheRead, costUSD: stats.cost };
        options.emit({ subagentId: options.id, event: { type: "spend", spend: {
          tokens: model.tokens, cached: model.cached, costUSD: model.costUSD, models: [model],
        } } });
        if (adapter) await adapter.dispose();
        else { await this.child.abort(); this.child.dispose(); }
      }
    }
  }
}
