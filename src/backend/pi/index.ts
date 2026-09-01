import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type { AgentBackend, BackendCreateOptions, BackendSession } from "../types.ts";
import type { BackendEvent, Capabilities, ModelInfo } from "../../protocol/events.ts";

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

export type PiBackendOptions = {
  /** Tool names pi may use. Omit for pi's defaults; pass [] to disable tools entirely. */
  tools?: string[];
};

export class PiSession implements BackendSession {
  capabilities: Capabilities;

  private readonly session: AgentSession;
  private readonly emit: (event: BackendEvent) => void;
  private readonly unsubscribe: () => void;

  private turnId: string | undefined;
  private aborting = false;
  private messageSeq = 0;
  private messageCount = 0;
  private currentMessageId: string | undefined;

  constructor(session: AgentSession, emit: (event: BackendEvent) => void) {
    this.session = session;
    this.emit = emit;
    this.capabilities = capabilitiesOf(session);
    this.unsubscribe = session.subscribe((event) => this.translate(event));
  }

  resumeToken(): string | undefined {
    // Revival arrives with durability in M2; pi persists through its SessionManager.
    return undefined;
  }

  async prompt(text: string): Promise<void> {
    this.turnId = `turn-${++this.messageSeq}`;
    this.emit({ type: "turn_started", turnId: this.turnId });
    await this.session.prompt(text, { streamingBehavior: "steer" });
  }

  async abort(): Promise<void> {
    this.aborting = true;
    await this.session.abort();
  }

  async setModel(modelId: string): Promise<void> {
    const model = this.session.modelRegistry.getAll().find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    await this.session.setModel(model);
    this.emit({ type: "model_changed", model: describeModel(model) });
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

    const { session } = await createAgentSession({
      cwd: options.scope,
      agentDir,
      resourceLoader,
      ...(this.options.tools ? { tools: this.options.tools } : {}),
      ...(this.options.tools?.length === 0 ? { noTools: "all" as const } : {}),
    });

    const piSession = new PiSession(session, options.emit);
    options.emit({ type: "capabilities_changed", capabilities: piSession.capabilities });
    return piSession;
  }
}

function capabilitiesOf(session: AgentSession): Capabilities {
  const models = session.modelRegistry.getAll().map(describeModel);
  const providers = [...new Set(models.map((model) => model.provider).filter(isString))];
  return {
    providers: providers.length > 0 ? providers : ["pi"],
    models,
    compaction: true,
    fork: false,
  };
}

function describeModel(model: { id: string; provider?: string; name?: string }): ModelInfo {
  return {
    id: model.id,
    ...(model.provider ? { provider: model.provider } : {}),
    ...(model.name ? { label: model.name } : {}),
  };
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
