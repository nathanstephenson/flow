import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type { AgentBackend, BackendCreateOptions, BackendSession, PromptAttachment } from "../types.ts";
import type {
  BackendEvent,
  Capabilities,
  EffortLevel,
  ModelInfo,
  Skill,
  TurnEndReason,
} from "../../protocol/events.ts";
import { clampEffort } from "../effort.ts";
import { ASK_TOOL, PiEnquiries } from "./enquiries.ts";
import { backgroundTools } from "./background-calls.ts";
import { SUBAGENT_TOOL, subagentTool, type SubagentInput } from "./subagents.ts";
import { PiWork, callIdFor, resultText, textResult, type Completion, type ToolResult } from "./work.ts";

/**
 * Backend Adapter for the pi SDK.
 *
 * Two mappings are deliberately not the obvious ones:
 *
 * 1. pi distinguishes an agentic run from a single model call (`turn_start`/`turn_end`). One Flow
 *    turn can contain many model calls, so it ends on `agent_settled`, when pi can accept new work.
 * 2. `agent_end` carries `willRetry` and arrives before SDK cleanup. It supplies the outcome, not
 *    permission to dispatch: ending the Flow turn there would race the Steering Queue against pi.
 *
 * pi also has a native follow-up queue. We never use it: the Steering Queue lives in the Session
 * Host (ADR 0002), so every prompt is sent with `streamingBehavior: "steer"`.
 */

/** pi does not export AgentMessage by that name; take it from the event union instead. */
type AgentMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];

/** pi calls Effort a thinking level, and its levels are a subset of ours. */
type ThinkingLevel = AgentSession["thinkingLevel"];
type PiModel = {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: object;
  /** pi's input modalities for this model — `("text" | "image")[]` in its registry. */
  input?: readonly string[];
};

export type PiBackendOptions = {
  /** Tool names pi may use. Omit for pi's defaults; pass [] to disable tools entirely. */
  tools?: string[];
};

export class PiSession implements BackendSession {
  capabilities: Capabilities;
  readonly answerEnquiry?: (askId: string, answers: string[][]) => Promise<boolean>;

  private readonly enquiries: PiEnquiries | undefined;
  private readonly work: PiWork | undefined;
  private readonly completions: Completion[] = [];
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private turnReason: TurnEndReason = "complete";
  private readonly session: AgentSession;
  private readonly emit: (event: BackendEvent) => void;
  private readonly unsubscribe: () => void;
  private readonly sessionDir: string | undefined;

  private turnId: string | undefined;
  /**
   * The turn a *requested* compaction opened, kept apart from `turnId` because pi compacts on its
   * own initiative too — and an automatic one runs inside a turn that is already open. Set only by
   * `compact`, so `compaction_end` can tell whose turn it is ending, if anyone's.
   */
  private compactionTurnId: string | undefined;
  private aborting = false;
  /** What the human asked for, kept apart from what is in force so a clamp is never destructive. */
  private wantedEffort: EffortLevel | undefined;
  private effort: EffortLevel | undefined;
  private messageSeq = 0;
  private messageCount = 0;
  private currentMessageId: string | undefined;

  constructor(session: AgentSession, emit: (event: BackendEvent) => void, sessionDir?: string,
    support: { enquiries?: PiEnquiries; work?: PiWork; subagents?: boolean } = {}) {
    this.session = session;
    this.emit = emit;
    this.sessionDir = sessionDir;
    this.enquiries = support.enquiries;
    this.work = support.work;
    const enquiries = support.enquiries;
    if (enquiries) this.answerEnquiry = async (askId, answers) => enquiries.answer(askId, answers);
    this.capabilities = capabilitiesOf(session, support.enquiries !== undefined, support.subagents ?? false);
    this.unsubscribe = session.subscribe((event) => this.translate(event));
  }

  resumeToken(): string | undefined {
    // pi persists through its own SessionManager; the directory we gave it is the resume handle.
    return this.sessionDir;
  }

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    this.turnId = `turn-${++this.messageSeq}`;
    this.emit({ type: "turn_started", turnId: this.turnId });
    await this.session.prompt(text, {
      streamingBehavior: "steer",
      // pi takes images beside the text rather than interleaved with it, so there is no ordering to
      // choose here the way there is on Claude's content array.
      ...(attachments?.length
        ? { images: attachments.map((a) => ({ type: "image" as const, data: a.data, mimeType: a.mediaType })) }
        : {}),
    });
  }

  async abort(): Promise<void> {
    this.aborting = this.turnId !== undefined;
    await this.session.abort();
  }

  async setModel(modelId: string): Promise<void> {
    const available = await this.session.modelRuntime.getAvailable();
    const qualified = available.find((candidate) => describeModel(candidate).id === modelId);
    const legacy = available.filter((candidate) => candidate.id === modelId);
    const model = qualified ?? (legacy.length === 1 ? legacy[0] : undefined);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    await this.session.setModel(model);
    // Which levels are on offer follows the model, and pi may have clamped its own thinking level
    // on the way through, so both the list and the level in force are re-read here.
    this.capabilities = capabilitiesOf(this.session, this.enquiries !== undefined, this.capabilities.subagents);
    this.emit({ type: "model_changed", model: describeModel(model) });
    this.emit({ type: "capabilities_changed", capabilities: this.capabilities });
    this.reapplyEffort();
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.wantedEffort = effort;
    this.applyEffort(effort);
  }

  /**
   * pi compacts first-class, so this is the whole implementation: it reports through
   * `compaction_end`, which `translate` already turns into a `compacted`.
   *
   * Not awaited to completion on purpose. pi resolves this when the summary exists, which is a model
   * call away, and the host's caller is an HTTP request that should not be held open for it — the
   * events are how anyone finds out either way. A failure still reaches the transcript, because pi
   * puts it on `compaction_end.errorMessage` rather than throwing.
   *
   * The turn is opened *here* rather than on `compaction_start`, because that event fires for pi's
   * automatic compactions as well — and those happen inside a turn that is already open. Only the
   * ones somebody asked for occupy a session of their own, and `compactionTurnId` is what tells the
   * two apart when the end arrives.
   */
  async compact(instructions?: string): Promise<void> {
    const turnId = `compaction-${++this.messageSeq}`;
    this.compactionTurnId = turnId;
    this.emit({ type: "turn_started", turnId });
    // A rejection here would never reach `compaction_end`, and a turn left open pins the session in
    // `running` forever — refusing every later send and every later compaction.
    void this.session.compact(instructions).catch((error: unknown) => {
      if (this.compactionTurnId !== turnId) return;
      this.emit({
        type: "notice",
        level: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      this.endCompactionTurn("error");
    });
  }

  /** Ends the turn a requested compaction opened, and does nothing for one pi started itself. */
  private endCompactionTurn(reason: TurnEndReason): void {
    const turnId = this.compactionTurnId;
    if (!turnId) return;
    this.compactionTurnId = undefined;
    this.emit({ type: "turn_ended", turnId, reason });
    this.scheduleCompletions();
  }

  /**
   * pi splits what Claude calls a Skill in two: a `Skill` is a capability the model may invoke, and a
   * `PromptTemplate` is a named prompt a human triggers. Both are offered here, because from the
   * composer they are the same act — type a name, get a prompt — and only the second has an
   * `argumentHint` to carry.
   *
   * Reloaded first, for the reason the Claude adapter rescans: a human who has just written one
   * opens the menu expecting to find it.
   */
  async skills(): Promise<Skill[]> {
    await this.session.resourceLoader.reload();
    const { skills } = this.session.resourceLoader.getSkills();
    const { prompts } = this.session.resourceLoader.getPrompts();
    return [
      ...skills.map((skill) => ({ name: skill.name, description: skill.description })),
      ...prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      })),
    ];
  }

  private applyEffort(wanted: EffortLevel): void {
    const level = clampEffort(wanted, availableEffort(this.session));
    // Nothing to set on a model with no effort control. The request stays on file, so switching
    // back to a model that has one restores it.
    if (!level) {
      this.effort = undefined;
      return;
    }
    // Safe: the level came out of pi's own list of what this model offers.
    this.session.setThinkingLevel(level as ThinkingLevel);
    this.effort = (this.session.thinkingLevel as EffortLevel | undefined) ?? level;
    this.emit({ type: "effort_changed", effort: this.effort });
  }

  /**
   * Report the thinking level pi is already on, for a session nobody has chosen one for.
   *
   * pi differs from the Claude adapter here, and it is a real difference rather than an oversight in
   * either: pi exposes `thinkingLevel` as state that can be read at any time, while Claude reports
   * its effort only in the init message that arrives with the first turn. So a pi session can say
   * what it is running at from the moment it starts, and a Claude one cannot — each reports what it
   * is able to, which is the same rule Capabilities sets.
   */
  noteStartingEffort(): void {
    const settled = this.session.thinkingLevel as EffortLevel | undefined;
    if (!settled || settled === this.effort) return;
    this.effort = settled;
    this.emit({ type: "effort_changed", effort: settled });
  }

  private reapplyEffort(): void {
    // With nothing asked for, whatever pi settled on *is* the answer.
    if (!this.wantedEffort) {
      this.noteStartingEffort();
      return;
    }
    if (clampEffort(this.wantedEffort, availableEffort(this.session)) === this.effort) return;
    this.applyEffort(this.wantedEffort);
  }

  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOnce();
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    this.completions.length = 0;
    try {
      await Promise.all([this.abort(), this.work?.dispose()]);
    } finally {
      this.unsubscribe();
      this.session.dispose();
    }
  }

  completed(completion: Completion): void {
    if (this.disposed) return;
    this.completions.push(completion);
    this.scheduleCompletions();
  }

  private scheduleCompletions(): void {
    queueMicrotask(() => {
      if (this.disposed || this.turnId || this.compactionTurnId || this.session.isStreaming || !this.completions.length) return;
      const completed = this.completions.splice(0).map(({ brief, state, result }) => ({ ...brief, state, output: resultText(result) }));
      const turnId = `turn-${++this.messageSeq}`;
      this.turnId = turnId;
      this.turnReason = "complete";
      this.emit({ type: "turn_started", turnId });
      void this.session.sendCustomMessage({ customType: "flow_completion", content: JSON.stringify(completed), display: false },
        { triggerTurn: true }).catch((error: unknown) => {
        this.emit({ type: "notice", level: "error", text: error instanceof Error ? error.message : String(error) });
        if (this.turnId === turnId) this.finishTurn("error");
      });
    });
  }

  private finishTurn(reason: TurnEndReason): void {
    const turnId = this.turnId;
    if (!turnId) return;
    this.turnId = undefined;
    this.aborting = false;
    this.turnReason = "complete";
    this.reportContextUsage();
    this.emit({ type: "turn_ended", turnId, reason });
    this.scheduleCompletions();
  }

  private translate(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        // turn_started is emitted on prompt() so the host sees it without waiting on the backend.
        return;

      case "message_start":
        this.currentMessageId = `msg-${this.messageSeq}-${++this.messageCount}`;
        this.emitMessage(event.message, false);
        return;

      case "message_update":
        this.emitMessage(event.message, false);
        return;

      case "message_end":
        this.emitMessage(event.message, true);
        this.currentMessageId = undefined;
        return;

      case "tool_execution_start":
        this.emit({ type: "tool_started", callId: event.toolCallId, name: event.toolName, input: event.args });
        return;

      case "tool_execution_update":
        this.emit({ type: "tool_updated", callId: event.toolCallId, update: event.partialResult });
        return;

      case "tool_execution_end":
        this.emit({
          type: "tool_ended",
          callId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        return;

      case "agent_end": {
        if (event.willRetry) return;
        const last = event.messages.findLast((message) => message.role === "assistant");
        this.turnReason = this.aborting || last?.stopReason === "aborted" ? "aborted"
          : last?.stopReason === "error" ? "error" : "complete";
        if (last?.stopReason === "error" && last.errorMessage) {
          this.emit({ type: "notice", level: "error", text: last.errorMessage });
        }
        return;
      }

      case "agent_settled":
        this.finishTurn(this.aborting ? "aborted" : this.turnReason);
        return;

      case "auto_retry_start":
        this.emit({
          type: "notice",
          level: "warn",
          text: `Retrying ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
        });
        return;

      case "auto_retry_end":
        if (!event.success && event.finalError) {
          this.emit({ type: "notice", level: "error", text: event.finalError });
        }
        return;

      /*
       * The start drives the chrome, never a transcript row — which is why it is translated now and
       * was not before. One compaction is still one row in both backends, because that row is
       * `compacted` and it comes from the end.
       *
       * pi announces its own compactions before they begin, so this fires for automatic ones too.
       * The Claude SDK reports only the boundary after the fact, so there the same state means "a
       * human asked and it has not come back". Each says what it can see.
       */
      case "compaction_start":
        this.emit({ type: "compacting", active: true });
        return;

      /*
       * A compaction that aborted or is about to be retried did not happen yet, so it records
       * nothing — the same rule `agent_end` applies to `willRetry` above. It still has to stop
       * saying it is working, so the state is cleared before any of that is decided.
       */
      case "compaction_end":
        this.emit({ type: "compacting", active: false });
        if (event.errorMessage) {
          this.emit({ type: "notice", level: "error", text: event.errorMessage });
        }
        if (event.willRetry) return;
        // pi counts what it started from and never what it ended at, so `after` goes unreported
        // rather than guessed. Only "manual" is somebody asking; a threshold and an overflow are
        // both pi deciding on its own.
        if (!event.aborted && event.result) {
          this.emit({
            type: "compacted",
            trigger: event.reason === "manual" ? "manual" : "auto",
            before: event.result.tokensBefore,
          });
        }
        // Last, so the marker lands while the turn is still open — `turn_ended` is what returns the
        // session to idle and lets the Steering Queue drain behind it.
        this.endCompactionTurn(event.aborted ? "aborted" : event.errorMessage ? "error" : "complete");
        return;

      default:
        return;
    }
  }

  private emitMessage(message: AgentMessage, final: boolean): void {
    if (message.role !== "assistant") return;
    const id = this.currentMessageId ?? `msg-${this.messageSeq}-${++this.messageCount}`;
    this.currentMessageId = id;

    const text = joinBlocks(message.content, "text");
    const thinking = joinBlocks(message.content, "thinking");
    if (text) this.emit({ type: "message", id, text, final });
    if (thinking) this.emit({ type: "thinking", id: `${id}-thinking`, text: thinking, final });
  }

  private reportContextUsage(): void {
    const usage = this.session.getContextUsage();
    if (usage && typeof usage.tokens === "number") {
      this.emit({ type: "context_usage", used: usage.tokens, window: usage.contextWindow });
    }
  }
}

export class PiBackend implements AgentBackend {
  readonly name = "pi";

  private readonly options: PiBackendOptions;

  constructor(options: PiBackendOptions = {}) {
    this.options = options;
  }

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    const agentDir = getAgentDir();
    // Extensions are not loaded: they expect pi's own UI surface, and a background session that
    // registers UI hooks has nowhere to render them.
    const settingsManager = SettingsManager.create(options.scope, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.scope,
      agentDir,
      settingsManager,
      noExtensions: true,
    });
    await resourceLoader.reload();

    // Reviving reopens the most recent pi session in the directory we gave this Agent Session;
    // a fresh Agent Session starts a new one there.
    const sessionDir = options.stateDir;
    const sessionManager = sessionDir
      ? options.resume
        ? SessionManager.continueRecent(options.scope, sessionDir)
        : SessionManager.create(options.scope, sessionDir)
      : undefined;

    const defaults = settingsManager.getDefaultTools() ?? ["read", "bash", "edit", "write"];
    const tools = options.tools === "none" ? [] : this.options.tools ?? [
      ...defaults, ASK_TOOL, SUBAGENT_TOOL, ...(defaults.includes("bash") ? ["bash_output", "kill_shell"] : []),
    ];
    const enabled = (name: string) => tools.includes(name);
    const enquiries = enabled(ASK_TOOL) ? new PiEnquiries(options.emit) : undefined;
    const work = new PiWork(options.emit, (completion) => piSession.completed(completion));
    const subagents = enabled(SUBAGENT_TOOL);
    const customTools = [
      ...backgroundTools(options.scope, settingsManager, work).filter((tool) => enabled(tool.name)),
      ...(enquiries ? [enquiries.tool] : []),
      ...(subagents ? [subagentTool(work, (id, input, signal) =>
        runSubagent(session, options.scope, agentDir, work, id, input, signal, options.emit))] : []),
    ];
    const { session } = await createAgentSession({
      cwd: options.scope,
      agentDir,
      resourceLoader,
      settingsManager,
      customTools,
      tools,
      ...(sessionManager ? { sessionManager } : {}),
      ...(tools.length === 0 ? { noTools: "all" as const } : {}),
    });

    const piSession = new PiSession(session, options.emit, sessionDir, { work, subagents, ...(enquiries ? { enquiries } : {}) });
    if (options.modelId) {
      try {
        await piSession.setModel(options.modelId);
      } catch (error) {
        await piSession.dispose();
        throw error;
      }
    }
    options.emit({ type: "capabilities_changed", capabilities: piSession.capabilities });
    // Which model is in force decides which effort levels a client may offer, so say it up front,
    // preferring the registry entry: that is the one carrying pi's own answer about its levels.
    if (session.model) {
      const described = describeModel(session.model);
      const listed = piSession.capabilities.models.find((model) => model.id === described.id);
      options.emit({ type: "model_changed", model: listed ?? described });
    }
    // Announced after the model, because which model is in force is what decides whether an effort
    // level means anything at all.
    if (options.effort) await piSession.setEffort(options.effort);
    else piSession.noteStartingEffort();
    return piSession;
  }
}

async function runSubagent(parent: AgentSession, scope: string, agentDir: string, work: PiWork, id: string,
  input: SubagentInput, signal: AbortSignal, emit: (event: BackendEvent) => void): Promise<ToolResult> {
  const available = parent.modelRuntime.getAvailableSnapshot();
  const model = input.model ? available.find((model) => describeModel(model).id === input.model) : parent.model;
  if (!model) throw new Error(`Unknown model: ${input.model}. Available: ${available.map((model) => describeModel(model).id).join(", ")}`);
  const effort = (input.effort ?? parent.thinkingLevel) as EffortLevel;
  const tools = parent.getActiveToolNames().filter((name) => name !== ASK_TOOL && name !== SUBAGENT_TOOL);
  const settingsManager = SettingsManager.create(scope, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: scope, agentDir, settingsManager, noExtensions: true,
    appendSystemPrompt: ["You are a Subagent. Complete the delegated work and return the result. If human input is needed, return that request to the parent. You cannot ask the human or create further Subagents."] });
  await resourceLoader.reload();
  signal.throwIfAborted();
  const producer = { subagentId: id };
  const { session: child } = await createAgentSession({ cwd: scope, agentDir, model, modelRuntime: parent.modelRuntime,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(scope), tools,
    customTools: backgroundTools(scope, settingsManager, work, producer, input.run_in_background === false).filter((tool) => tools.includes(tool.name)),
  });
  let output = "";
  let failure: string | undefined;
  let reason: TurnEndReason = "complete";
  const adapter = new PiSession(child, (event) => {
    switch (event.type) {
      case "message":
      case "thinking":
        work.waiting(id, false);
        if (event.type === "message" && event.final) output = event.text;
        emit({ ...event, id: callIdFor(event.id, producer), producer });
        break;
      case "tool_started":
      case "tool_updated":
      case "tool_ended":
        if (event.type === "tool_started") work.waiting(id, false);
        emit({ ...event, callId: callIdFor(event.callId, producer), producer });
        break;
      case "notice":
        if (event.level === "warn") work.waiting(id, true);
        if (event.level === "error") failure = event.text;
        emit({ ...event, text: `${input.name ?? "Subagent"}: ${event.text}` });
        break;
      case "turn_ended": reason = event.reason; break;
    }
  });
  const abort = () => { void adapter.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await adapter.setEffort(effort);
    signal.throwIfAborted();
    await adapter.prompt(input.prompt);
    if (reason !== "complete") throw new Error(failure ?? `Subagent ${reason}`);
    return textResult(output || "Subagent completed without text output");
  } finally {
    signal.removeEventListener("abort", abort);
    await adapter.dispose();
    if (input.run_in_background === false) await work.stopOwnedCalls(id);
  }
}

function capabilitiesOf(session: AgentSession, enquiries: boolean, subagents: boolean): Capabilities {
  const current = session.model ? describeModel(session.model).id : undefined;
  // The SDK populates this auth-filtered snapshot before createAgentSession resolves.
  const models = session.modelRuntime.getAvailableSnapshot().map((model) => {
    const described = describeModel(model);
    // pi will only answer for the model it has selected, and that answer is the authoritative one.
    // Every other entry is inferred from the registry and firms up if you switch to it.
    if (described.id !== current) return described;
    const available = availableEffort(session);
    return available.length > 0 ? { ...described, effortLevels: available } : omitEffort(described);
  });
  const providers = [...new Set(models.map((model) => model.provider).filter(isString))];
  return {
    providers: providers.length > 0 ? providers : ["pi"],
    models,
    compaction: true,
    fork: false,
    subagents,
    enquiries,
    permissions: false,
  };
}

function describeModel(model: PiModel): ModelInfo {
  const effortLevels = inferredEffort(model);
  return {
    id: model.provider ? `${model.provider}/${model.id}` : model.id,
    ...(model.provider ? { provider: model.provider } : {}),
    ...(model.name ? { label: model.name } : {}),
    ...(effortLevels.length > 0 ? { effortLevels } : {}),
    // Read from the registry rather than inferred, and so trustworthy for every entry rather than
    // only the selected one — unlike the Effort levels above, pi does not make this depend on which
    // model is in force.
    ...(model.input?.includes("image") ? { acceptsImages: true as const } : {}),
  };
}

/** The levels pi will accept for the model it currently has selected. */
function availableEffort(session: AgentSession): EffortLevel[] {
  return session.supportsThinking() ? (session.getAvailableThinkingLevels() as EffortLevel[]) : [];
}

/**
 * What a model that is not currently selected probably offers. A model that cannot reason offers
 * nothing; otherwise its thinkingLevelMap names the levels it was configured with.
 */
function inferredEffort(model: PiModel): EffortLevel[] {
  if (model.reasoning === false) return [];
  const map = model.thinkingLevelMap as Partial<Record<EffortLevel, unknown>> | undefined;
  if (!map) return model.reasoning ? PI_EFFORT_LEVELS : [];
  return PI_EFFORT_LEVELS.filter((level) => map[level] !== undefined && map[level] !== null);
}

const PI_EFFORT_LEVELS: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function omitEffort(model: ModelInfo): ModelInfo {
  const { effortLevels: _dropped, ...rest } = model;
  return rest;
}

function joinBlocks(content: unknown, kind: "text" | "thinking"): string {
  if (typeof content === "string") return kind === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string; thinking?: string } =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === kind)
    .map((block) => (kind === "text" ? block.text : block.thinking) ?? "")
    .join("");
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
