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
import type { BackendEvent, Capabilities, EffortLevel, ModelInfo } from "../../protocol/events.ts";
import { clampEffort } from "../effort.ts";

/**
 * Backend Adapter for the pi SDK.
 *
 * Two mappings are deliberately not the obvious ones:
 *
 * 1. pi distinguishes an agentic *run* (`agent_start`/`agent_end`) from a single model *turn*
 *    (`turn_start`/`turn_end`), and one prompt produces many of the latter. Our turn is an exchange
 *    with the human, so it maps to agent_*. Mapping to turn_* would emit N pairs per prompt.
 * 2. `agent_end` carries `willRetry`. When set, pi is about to auto-retry and the exchange is not
 *    over, so no turn_ended is emitted until a run ends for good.
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

  private readonly session: AgentSession;
  private readonly emit: (event: BackendEvent) => void;
  private readonly unsubscribe: () => void;
  private readonly sessionDir: string | undefined;

  private turnId: string | undefined;
  private aborting = false;
  /** What the human asked for, kept apart from what is in force so a clamp is never destructive. */
  private wantedEffort: EffortLevel | undefined;
  private effort: EffortLevel | undefined;
  private messageSeq = 0;
  private messageCount = 0;
  private currentMessageId: string | undefined;

  constructor(session: AgentSession, emit: (event: BackendEvent) => void, sessionDir?: string) {
    this.session = session;
    this.emit = emit;
    this.sessionDir = sessionDir;
    this.capabilities = capabilitiesOf(session);
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
    this.aborting = true;
    await this.session.abort();
  }

  async setModel(modelId: string): Promise<void> {
    const model = this.session.modelRegistry.getAll().find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    await this.session.setModel(model);
    // Which levels are on offer follows the model, and pi may have clamped its own thinking level
    // on the way through, so both the list and the level in force are re-read here.
    this.capabilities = capabilitiesOf(this.session);
    this.emit({ type: "model_changed", model: describeModel(model) });
    this.emit({ type: "capabilities_changed", capabilities: this.capabilities });
    this.reapplyEffort();
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.wantedEffort = effort;
    this.applyEffort(effort);
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

  async dispose(): Promise<void> {
    this.unsubscribe();
    this.session.dispose();
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
        if (event.willRetry) return; // pi is about to retry; the exchange is not over.
        this.reportContextUsage();
        const turnId = this.turnId;
        if (!turnId) return;
        this.turnId = undefined;
        const reason = this.aborting ? "aborted" : "complete";
        this.aborting = false;
        this.emit({ type: "turn_ended", turnId, reason });
        return;
      }

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

      case "compaction_end":
        if (event.errorMessage) {
          this.emit({ type: "notice", level: "error", text: event.errorMessage });
        }
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
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.scope,
      agentDir,
      settingsManager: SettingsManager.create(options.scope, agentDir),
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

    const { session } = await createAgentSession({
      cwd: options.scope,
      agentDir,
      resourceLoader,
      ...(sessionManager ? { sessionManager } : {}),
      ...(this.options.tools ? { tools: this.options.tools } : {}),
      ...(this.options.tools?.length === 0 ? { noTools: "all" as const } : {}),
    });

    const piSession = new PiSession(session, options.emit, sessionDir);
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

function capabilitiesOf(session: AgentSession): Capabilities {
  const current = session.model?.id;
  const models = session.modelRegistry.getAll().map((model) => {
    const described = describeModel(model);
    // pi will only answer for the model it has selected, and that answer is the authoritative one.
    // Every other entry is inferred from the registry and firms up if you switch to it.
    if (model.id !== current) return described;
    const available = availableEffort(session);
    return available.length > 0 ? { ...described, effortLevels: available } : omitEffort(described);
  });
  const providers = [...new Set(models.map((model) => model.provider).filter(isString))];
  return {
    providers: providers.length > 0 ? providers : ["pi"],
    models,
    compaction: true,
    fork: false,
  };
}

function describeModel(model: PiModel): ModelInfo {
  const effortLevels = inferredEffort(model);
  return {
    id: model.id,
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
