import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

import {
  query,
  type EffortLevel as SdkEffortLevel,
  type ModelInfo as SdkModelInfo,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentBackend, BackendCreateOptions, BackendSession } from "../types.ts";
import type {
  BackendEvent,
  Capabilities,
  EffortLevel,
  ModelInfo,
  TurnEndReason,
} from "../../protocol/events.ts";
import { clampEffort } from "../effort.ts";
import { AsyncQueue } from "./async-queue.ts";
import { StreamedMessage } from "./streamed-message.ts";

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
 * A JS install is run as `<node> <cli-path> ...`, using process.execPath as the interpreter. Inside
 * a single executable, process.execPath is *this binary*, so that spawn re-invokes GoodHarness with
 * the CLI's arguments, argument parsing rejects them, and the exit status surfaces as "Claude Code
 * process exited with code 1". Executing the CLI path directly sidesteps the interpreter entirely.
 *
 * A native install has no interpreter to get wrong: the SDK spawns the binary as the command and
 * args[0] is a real flag. Hoisting args[0] there would execute `--output-format` as a program, and
 * the SDK reports the resulting failure as a libc mismatch, which sends you a long way off course.
 */
export function seaSpawnTarget(options: { command: string; args: string[] }): {
  command: string;
  args: string[];
} {
  if (options.command !== process.execPath) return options;
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
  private modelId: string | undefined;
  private bootedModel: string | undefined;
  /** The last model id reported to clients, so the model in force is announced exactly once. */
  private announced: string | undefined;
  /** Alias (`opus[1m]`) keyed by the id the SDK reports once a model is resolved. */
  private aliasOf = new Map<string, string>();
  /** What the human asked for, kept apart from what is in force so a clamp is never destructive. */
  private wantedEffort: EffortLevel | undefined;
  private effort: EffortLevel | undefined;
  /** The assistant message in flight, which owns the id its partial and finished halves share. */
  private streamed = new StreamedMessage();

  constructor(options: BackendCreateOptions, backendOptions: ClaudeBackendOptions) {
    this.emit = options.emit;
    this.modelId = options.modelId;
    this.wantedEffort = options.effort;

    const allowed = backendOptions.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const startingEffort = sdkEffort(options.effort);
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
      // Effort is also settable later, but starting with it avoids a first turn at the wrong level
      // while the model list is still in flight. Levels Claude does not have wait for the clamp.
      ...(startingEffort ? { effort: startingEffort } : {}),
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
    void this.loadModels();
  }

  /**
   * Ask the CLI what models this account can actually reach.
   *
   * The init message only names the model the session booted with, which made the picker a list of
   * one. `supportedModels()` is a control request rather than part of the message stream, so it
   * answers before the first prompt — the session advertises the real list from the start.
   */
  private async loadModels(): Promise<void> {
    let models: SdkModelInfo[];
    try {
      models = await this.stream.supportedModels();
    } catch (error) {
      this.emit({ type: "notice", level: "warn", text: `Could not list models: ${message(error)}` });
      return;
    }
    if (this.disposed) return;

    this.aliasOf = new Map(
      models.filter((model) => model.resolvedModel).map((model) => [model.resolvedModel ?? "", model.value]),
    );
    this.capabilities = { ...this.capabilities, models: models.map(describeModel) };
    this.emit({ type: "capabilities_changed", capabilities: this.capabilities });
    // Which model is in force decides which effort levels a client may offer, so say it now
    // rather than waiting for the init message that only arrives with the first turn.
    this.noteBootedModel(this.bootedModel ?? this.modelId ?? defaultModel(models));
    await this.reapplyEffort();
  }

  /**
   * The init message names the model in its resolved form (`claude-sonnet-...`), but the picker
   * lists aliases (`sonnet`). Report the alias so the id a client holds matches an entry it can
   * offer; before the list has arrived there is nothing to match against, and the raw id stands
   * until loadModels comes back and corrects it.
   */
  private noteBootedModel(booted: string | undefined): void {
    if (!booted) return;
    this.bootedModel = booted;
    // An id `capabilities.models` cannot describe costs the label *and* the Effort levels, so it must
    // never displace one the list can describe. With nothing announced yet there is nothing to
    // protect and the raw id still beats silence.
    this.announceModel(modelInForce(booted, this.aliasOf, this.capabilities.models) ?? this.announced ?? booted);
  }

  private announceModel(modelId: string): void {
    if (modelId === this.announced) return;
    this.announced = modelId;
    this.modelId = modelId;
    this.emit({ type: "model_changed", model: this.modelInfo(modelId) });
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
    this.announceModel(modelId);
    await this.reapplyEffort();
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.wantedEffort = effort;
    await this.applyEffort(effort);
  }

  /**
   * The SDK has no setEffort(): `effortLevel` is a settings key, and applyFlagSettings is how a
   * live session is told about one. It is the same key the CLI's own effort control writes.
   */
  private async applyEffort(wanted: EffortLevel): Promise<void> {
    const level = clampEffort(wanted, this.modelInfo(this.modelId).effortLevels);
    // A model with no effort control (haiku) leaves the request on file, unapplied: clients hide
    // the control for such a model, and switching back to one that has it restores the choice.
    const effortLevel = sdkEffort(level);
    if (!effortLevel) {
      this.effort = undefined;
      return;
    }
    try {
      await this.stream.applyFlagSettings({ effortLevel });
    } catch (error) {
      this.emit({ type: "notice", level: "warn", text: `Could not set effort: ${message(error)}` });
      return;
    }
    this.effort = effortLevel;
    this.emit({ type: "effort_changed", effort: effortLevel });
  }

  /** After a model change, only re-apply when the new model forces a different level. */
  private async reapplyEffort(): Promise<void> {
    if (!this.wantedEffort) return;
    if (clampEffort(this.wantedEffort, this.modelInfo(this.modelId).effortLevels) === this.effort) return;
    await this.applyEffort(this.wantedEffort);
  }

  private modelInfo(modelId: string | undefined): ModelInfo {
    const known = this.capabilities.models.find((model) => model.id === modelId);
    return known ?? { id: modelId ?? "default", provider: "anthropic" };
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
          this.noteBootedModel(sdkMessage.model);
        }
        return;

      case "stream_event":
        this.translateStreamEvent(sdkMessage.event);
        return;

      case "assistant": {
        // The streamed copy and this one are the same Entry, and StreamedMessage is what guarantees
        // it. Tool calls stay here: they have nothing to do with the partial-message state.
        for (const event of this.streamed.finish(sdkMessage.message.id, sdkMessage.message.content)) {
          this.emit(event);
        }
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
      this.streamed.start(event.message.id);
      return;
    }
    if (event.type !== "content_block_delta") return;

    const delta = event.delta;
    if (delta.type === "text_delta") this.emit(this.streamed.text(event.index, delta.text));
    else if (delta.type === "thinking_delta") this.emit(this.streamed.thinking(event.index, delta.thinking));
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

/** Claude reports one Provider, and per-model effort: haiku carries no supportedEffortLevels. */
/**
 * Which model id to announce for the one the SDK just named.
 *
 * The picker lists aliases (`opus[1m]`) because that is what `supportedModels()` reports as `value`,
 * while the init message at the start of every turn names the model in its *resolved* form
 * (`claude-opus-5`). Announcing the resolved form is not a cosmetic problem: `effortChoices` and the
 * picker's label both find the model by id in `capabilities.models`, so an id that is not on the list
 * has no `effortLevels` and no `label` — the Effort control disappears entirely and the model pill
 * falls back to printing the raw id. That happened one turn into every Agent Session.
 *
 * `undefined` means "nothing here worth announcing": the caller keeps what it already had rather than
 * trading a described model for an undescribed one.
 */
export function modelInForce(
  named: string,
  aliasOf: ReadonlyMap<string, string>,
  models: readonly ModelInfo[],
): string | undefined {
  const alias = aliasOf.get(named) ?? named;
  // Before the list arrives there is nothing to match against, and the raw id stands until
  // loadModels comes back and corrects it.
  if (models.length === 0) return alias;
  return models.some((model) => model.id === alias) ? alias : undefined;
}

export function describeModel(model: SdkModelInfo): ModelInfo {
  return {
    id: model.value,
    provider: "anthropic",
    label: model.displayName,
    ...(model.supportedEffortLevels?.length ? { effortLevels: [...model.supportedEffortLevels] } : {}),
  };
}

/** Absent an override, the entry Claude itself calls the default is the model in force. */
function defaultModel(models: SdkModelInfo[]): string | undefined {
  return (models.find((model) => model.value === "default") ?? models[0])?.value;
}

/** Claude has no `off` or `minimal`; those wait for the clamp rather than being mistranslated. */
function sdkEffort(effort: EffortLevel | undefined): SdkEffortLevel | undefined {
  return effort === undefined || effort === "off" || effort === "minimal"
    ? undefined
    : (effort satisfies SdkEffortLevel);
}



function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
