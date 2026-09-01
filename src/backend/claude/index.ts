import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentBackend, BackendCreateOptions, BackendSession } from "../types.ts";
import type { BackendEvent, Capabilities, ModelInfo, TurnEndReason } from "../../protocol/events.ts";
import { AsyncQueue } from "./async-queue.ts";

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

/**
 * Backend Adapter for the Claude Agent SDK.
 *
 * The lifecycle mismatch is the whole job here: `query()` models a run, we need a session. A
 * never-closing AsyncQueue keeps one run open for the Agent Session's life, and prompts are pushed
 * into it. Streaming input mode is required for `interrupt()` and `setModel()` anyway.
 *
 * Tools are pre-approved, but `permissionMode: "bypassPermissions"` alone is not enough: a tool
 * outside the allowlist would have nothing to resolve its permission request and the turn would
 * stall. `canUseTool` denies with a reason instead, so the agent is told and keeps going.
 */

export type ClaudeBackendOptions = {
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  /** Where the Claude Code CLI lives. Needed in a bundled build; see resolveClaudeExecutable. */
  pathToClaudeCodeExecutable?: string;
};

/**
 * Locate the Claude Code CLI.
 *
 * The Agent SDK spawns the CLI as a child process, and a child needs a real file on disk. Normally
 * the SDK finds it inside its own package, but a single-executable build has no node_modules to
 * look in — so there, Claude Code is a documented prerequisite and we resolve it from PATH.
 */
export function resolveClaudeExecutable(): string | undefined {
  const override = process.env["GOODHARNESS_CLAUDE_PATH"];
  if (override) return override;
  if (!isSingleExecutable()) return undefined;

  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
    encoding: "utf8",
  });
  const path = found.stdout?.split("\n")[0]?.trim();
  if (!path) {
    throw new Error(
      "Claude Code was not found on PATH. A GoodHarness binary needs it installed separately: " +
        "npm i -g @anthropic-ai/claude-code (or set GOODHARNESS_CLAUDE_PATH).",
    );
  }
  return path;
}

/**
 * Work out what to actually execute when the SDK asks for the CLI.
 *
 * The SDK runs the CLI as `<node> <cli-path> ...`, using process.execPath as the interpreter. Inside
 * a single executable, process.execPath is *this binary*, so that spawn re-invokes GoodHarness with
 * the CLI's arguments, argument parsing rejects them, and the exit status surfaces as "Claude Code
 * process exited with code 1". Executing the CLI path directly sidesteps the interpreter entirely,
 * which works whether Claude Code is installed as a shebang script or a native binary.
 */
export function seaSpawnTarget(options: { command: string; args: string[] }): {
  command: string;
  args: string[];
} {
  const [cliPath, ...rest] = options.args;
  if (!cliPath) return options;
  return { command: cliPath, args: rest };
}

function spawnClaudeDirectly(options: SpawnOptions): SpawnedProcess {
  const target = seaSpawnTarget(options);
  return spawn(target.command, target.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as SpawnedProcess;
}

function isSingleExecutable(): boolean {
  // getBuiltinModule works the same in ESM and in the CommonJS bundle a SEA build produces.
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?(): boolean } | undefined;
  return sea?.isSea?.() ?? false;
}

const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookEdit",
];

class ClaudeSession implements BackendSession {
  capabilities: Capabilities = { providers: ["anthropic"], models: [], compaction: true, fork: true };

  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly emit: (event: BackendEvent) => void;
  private readonly stream: Query;
  private readonly pump: Promise<void>;

  private sdkSessionId = "";
  private turnId: string | undefined;
  private disposed = false;
  /** Accumulates streamed text per content-block index so we can emit whole snapshots. */
  private partial = new Map<number, string>();
  private partialMessageId: string | undefined;

  constructor(options: BackendCreateOptions, backendOptions: ClaudeBackendOptions) {
    this.emit = options.emit;

    const allowed = backendOptions.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const queryOptions: Options = {
      cwd: options.scope,
      includePartialMessages: true,
      // NOT bypassPermissions: it auto-approves before canUseTool is consulted, and the SDK warns
      // as much. "default" runs the permission flow, allowedTools auto-approves the pre-approved
      // set, and canUseTool catches only the fall-through so nothing can stall waiting on a prompt.
      permissionMode: "default",
      allowedTools: allowed,
      ...(backendOptions.disallowedTools ? { disallowedTools: backendOptions.disallowedTools } : {}),
      ...(backendOptions.systemPrompt ? { systemPrompt: backendOptions.systemPrompt } : {}),
      ...(options.modelId ? { model: options.modelId } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(backendOptions.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: backendOptions.pathToClaudeCodeExecutable }
        : {}),
      ...(isSingleExecutable() ? { spawnClaudeCodeProcess: spawnClaudeDirectly } : {}),
      canUseTool: async (toolName: string) =>
        allowed.includes(toolName)
          ? { behavior: "allow" as const, updatedInput: {} }
          : {
              behavior: "deny" as const,
              message: `${toolName} is not enabled for this session. Continue without it.`,
            },
    };

    this.stream = query({ prompt: this.inbox, options: queryOptions });
    this.pump = this.consume();
  }

  resumeToken(): string | undefined {
    return this.sdkSessionId || undefined;
  }

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("Backend Session disposed");
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
    this.inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId,
    } as SDKUserMessage);
  }

  async abort(): Promise<void> {
    try {
      await this.stream.interrupt();
    } catch (error) {
      this.emit({ type: "notice", level: "warn", text: `Interrupt failed: ${message(error)}` });
    }
  }

  async setModel(modelId: string): Promise<void> {
    await this.stream.setModel(modelId);
    this.emit({ type: "model_changed", model: { id: modelId, provider: "anthropic" } });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.inbox.close();
    try {
      await this.stream.close();
    } catch {
      // Closing a stream that already ended is not an error worth surfacing.
    }
    await this.pump.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    try {
      for await (const sdkMessage of this.stream) {
        this.translate(sdkMessage);
      }
    } catch (error) {
      if (!this.disposed) {
        this.emit({ type: "notice", level: "error", text: message(error) });
        this.endTurn("error");
      }
    }
  }

  private translate(sdkMessage: SDKMessage): void {
    switch (sdkMessage.type) {
      case "system":
        if (sdkMessage.subtype === "init") {
          this.sdkSessionId = sdkMessage.session_id;
          this.capabilities = {
            providers: ["anthropic"],
            models: modelsFrom(sdkMessage),
            compaction: true,
            fork: true,
          };
          this.emit({ type: "capabilities_changed", capabilities: this.capabilities });
        }
        return;

      case "stream_event":
        this.translateStreamEvent(sdkMessage.event);
        return;

      case "assistant": {
        this.partial.clear();
        this.partialMessageId = undefined;
        const id = sdkMessage.message.id;
        const text = textOf(sdkMessage.message.content);
        if (text) this.emit({ type: "message", id, text, final: true });
        for (const block of sdkMessage.message.content) {
          if (block.type === "tool_use") {
            this.emit({ type: "tool_started", callId: block.id, name: block.name, input: block.input });
          }
        }
        return;
      }

      case "user": {
        const content = sdkMessage.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            this.emit({
              type: "tool_ended",
              callId: block.tool_use_id,
              result: block.content ?? "",
              isError: block.is_error === true,
            });
          }
        }
        return;
      }

      case "result": {
        if ("usage" in sdkMessage && sdkMessage.usage) {
          const used = (sdkMessage.usage.input_tokens ?? 0) + (sdkMessage.usage.output_tokens ?? 0);
          if (used > 0) this.emit({ type: "context_usage", used, window: 0 });
        }
        this.endTurn(sdkMessage.subtype === "success" ? "complete" : "error");
        return;
      }

      default:
        return;
    }
  }

  private translateStreamEvent(event: StreamEvent): void {
    if (event.type === "message_start") {
      this.partial.clear();
      this.partialMessageId = event.message.id ?? randomUUID();
      return;
    }
    if (event.type !== "content_block_delta") return;

    const index = event.index;
    const delta = event.delta;

    if (delta.type === "text_delta") {
      const accumulated = (this.partial.get(index) ?? "") + delta.text;
      this.partial.set(index, accumulated);
      this.emit({
        type: "message",
        id: this.partialMessageId ?? "streaming",
        text: [...this.partial.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join(""),
        final: false,
      });
      return;
    }

    if (delta.type === "thinking_delta") {
      const key = index + 10_000;
      const accumulated = (this.partial.get(key) ?? "") + delta.thinking;
      this.partial.set(key, accumulated);
      this.emit({
        type: "thinking",
        id: `${this.partialMessageId ?? "streaming"}-thinking`,
        text: accumulated,
        final: false,
      });
    }
  }

  private endTurn(reason: TurnEndReason): void {
    const turnId = this.turnId;
    if (!turnId) return;
    this.turnId = undefined;
    this.emit({ type: "turn_ended", turnId, reason });
  }
}

export class ClaudeBackend implements AgentBackend {
  readonly name = "claude";

  private readonly options: ClaudeBackendOptions;

  constructor(options: ClaudeBackendOptions = {}) {
    const resolved = options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable();
    this.options = { ...options, ...(resolved ? { pathToClaudeCodeExecutable: resolved } : {}) };
  }

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    // Deliberately not awaiting init: in streaming-input mode the SDK emits nothing until the
    // input stream yields, so waiting for the init message before returning would deadlock. The
    // session starts with provisional capabilities and emits capabilities_changed once known.
    return new ClaudeSession(options, this.options);
  }
}

function modelsFrom(init: { model?: string }): ModelInfo[] {
  return init.model ? [{ id: init.model, provider: "anthropic", label: init.model }] : [];
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
