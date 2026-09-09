import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

import {
  query,
  type EffortLevel as SdkEffortLevel,
  type ModelInfo as SdkModelInfo,
  type Options,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentBackend, BackendCreateOptions, BackendSession, PromptAttachment } from "../types.ts";
import type {
  BackendEvent,
  Capabilities,
  EffortLevel,
  ModelInfo,
  ModelSpend,
  Producer,
  Skill,
  Spend,
  TurnEndReason,
} from "../../protocol/events.ts";
import { clampEffort } from "../effort.ts";
import { AsyncQueue } from "./async-queue.ts";
import { ASK_TOOL, PendingEnquiries, questionsOf } from "./enquiries.ts";
import { StreamedMessages } from "./streamed-message.ts";
import { Subagents, type SubagentBrief } from "./subagents.ts";

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
  const override = process.env["FLOW_CLAUDE_PATH"];
  if (override) return override;
  if (!isSingleExecutable()) return undefined;

  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
    encoding: "utf8",
  });
  const path = found.stdout?.split("\n")[0]?.trim();
  if (!path) {
    throw new Error(
      "Claude Code was not found on PATH. A Flow binary needs it installed separately: " +
        "npm i -g @anthropic-ai/claude-code (or set FLOW_CLAUDE_PATH).",
    );
  }
  return path;
}

/**
 * Work out what to actually execute when the SDK asks for the CLI.
 *
 * A JS install is run as `<node> <cli-path> ...`, using process.execPath as the interpreter. Inside
 * a single executable, process.execPath is *this binary*, so that spawn re-invokes Flow with
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

/**
 * The tool whose call spawns a Subagent, and whose result returns it.
 *
 * `Agent`, not `Task`: the CLI emits `tool_use` with name `Agent`, and the subagent's own tool calls
 * carry that call's id as their `parent_tool_use_id`.
 */
const SUBAGENT_TOOL = "Agent";

/**
 * Who produced an SDK message: the callId of the spawning tool call, or `""` for the Agent Session's
 * own model. A string rather than `string | undefined` so it can key a Map without a sentinel.
 */
function producerOf(sdkMessage: { parent_tool_use_id?: string | null }): string {
  return sdkMessage.parent_tool_use_id ?? "";
}

/** Spread onto an event, so an unattributed one carries no explicit `producer: undefined`. */
function attribution(producer: string): { producer?: Producer } {
  return producer === "" ? {} : { producer: { subagentId: producer } };
}

/**
 * What a Subagent is called and was asked to do, read off the spawning tool call.
 *
 * `subagent_type` is the subagent's declared identity (`Explore`) and `description` the one-line
 * brief; the full `prompt` is deliberately not carried, being the whole instruction rather than
 * something a transcript row can show. Falls back to the tool name so a client always has something
 * to print, which is what the protocol promises.
 */
export function briefOf(input: unknown): SubagentBrief {
  const fields = (input ?? {}) as { subagent_type?: unknown; description?: unknown };
  const name = typeof fields.subagent_type === "string" ? fields.subagent_type : SUBAGENT_TOOL;
  const description = typeof fields.description === "string" ? fields.description : undefined;
  return description === undefined ? { name } : { name, description };
}

/**
 * Whether an `Agent` tool result is a launch receipt rather than the Subagent's answer.
 *
 * A backgrounded agent — which the SDK documents as the default — returns its `tool_result` at
 * once, carrying an id and an output file instead of a report. Read from `tool_use_result`, the
 * structured `AgentOutput` the SDK asks callers to render from, rather than sniffed out of the
 * result text, which is prose written for the model and free to change.
 *
 * `remote_launched` counts too: it is the same promise about a different machine.
 */
export function isAsyncLaunch(result: unknown): boolean {
  const status = (result as { status?: unknown } | null | undefined)?.status;
  return status === "async_launched" || status === "remote_launched";
}

/** How a settled task reports itself, in the three words a Subagent and a turn already share. */
function outcomeOf(status: string): TurnEndReason | undefined {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  if (status === "stopped" || status === "killed") return "aborted";
  return undefined;
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
  // Without this a session that reaches plan mode can never leave it: the deny message ends
  // "Continue without it", so the model proceeds read-only instead of surfacing the refusal, and
  // every edit for the rest of the session fails for a reason it cannot name.
  "ExitPlanMode",
  "Skill",
  // Spawns a Subagent. A Subagent's own conversation never enters this session's Conversation
  // Context — only the call and the summary it returns do — so the context meter stays accurate;
  // what it cannot show is what the Subagent spent, which is a different measure.
  "Agent",
];

class ClaudeSession implements BackendSession {
  capabilities: Capabilities = { providers: ["anthropic"], models: [], compaction: true, fork: true, subagents: true, enquiries: true };

  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly emit: (event: BackendEvent) => void;
  private readonly stream: Query;
  private readonly pump: Promise<void>;

  private sdkSessionId = "";
  private turnId: string | undefined;
  /** Set between asking the CLI for a compaction and the `result` that closes it. See `compact`. */
  private compacting = false;
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
  /** The assistant message in flight, per producer. See StreamedMessages for why it is not one. */
  private readonly streamed = new StreamedMessages();
  /** Subagents open in this turn, and any turn end waiting on them. */
  private readonly subagents = new Subagents();
  private readonly enquiries = new PendingEnquiries();
  /**
   * Everything this Agent Session has spent, across every model and every Backend Session.
   *
   * Seeded from what it had spent before this one opened, because `modelUsage` counts only this
   * `query()` run: on a Revive its counters start at zero, and reporting that alone would read as
   * the bill resetting itself.
   */
  private spend: Spend | undefined;
  private readonly priorSpend: Spend | undefined;

  constructor(options: BackendCreateOptions, backendOptions: ClaudeBackendOptions) {
    this.emit = options.emit;
    this.modelId = options.modelId;
    this.wantedEffort = options.effort;
    this.priorSpend = options.priorSpend;
    // Reported before this run has billed anything, so a Revive does not blank the meter it inherits.
    this.spend = options.priorSpend;

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
      /*
       * The fall-through, and — for exactly one tool — the whole of how a human is asked something.
       *
       * `AskUserQuestion` is deliberately absent from `allowed`: an allowlisted tool is approved
       * before this runs, so putting it there would answer the model's question with silence. It
       * reaches here instead, and here the callback is *parked* rather than answered, which is the
       * one place this adapter does not resolve a permission immediately. What settles it is a human,
       * through `answerEnquiry` — or, on every path where there will never be one, an abandonment.
       */
      canUseTool: async (toolName: string, input: Record<string, unknown>, extra: { toolUseID: string }) => {
        if (toolName === ASK_TOOL) return await this.ask(extra.toolUseID, input);
        return allowed.includes(toolName)
          ? { behavior: "allow" as const, updatedInput: input }
          : {
              behavior: "deny" as const,
              message: `${toolName} is not enabled for this session. Continue without it.`,
            };
      },
    };

    this.stream = query({ prompt: this.inbox, options: queryOptions });
    this.pump = this.consume();
    void this.loadModels();
    // A meter that only fills once a turn ends reads as "no window" when it is really just early.
    // Occupancy is already meaningful here: system prompt, tools and memory files are loaded
    // before anything is sent.
    void this.reportContextUsage();
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

  /**
   * The effort the SDK says it is actually running at.
   *
   * This is the *only* place Claude reports it — `initializationResult()` does not carry it, and
   * `supportedModels()` describes which levels exist rather than which is in force. So a session
   * nobody has set an effort on stays unreported until its first turn brings this message, which is
   * why `EffortPicker` has a placeholder to fall back to rather than a value.
   *
   * `null` means the model has no effort control, which is a state rather than a failure: haiku
   * reports it, clients hide the control for such a model, and a level left on file in
   * `wantedEffort` is restored by `reapplyEffort` on the way back to a model that has one.
   *
   * Announced only on a difference, so a turn that changed nothing says nothing — and taken as the
   * truth when it disagrees with what we asked for, because the SDK clamps and this is it telling
   * us what it settled on.
   */
  private noteBootedEffort(booted: SdkEffortLevel | null | undefined): void {
    if (booted === undefined || booted === null) return;
    if (booted === this.effort) return;
    this.effort = booted;
    this.emit({ type: "effort_changed", effort: booted });
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

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    if (this.disposed) throw new Error("Backend Session disposed");
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
    this.inbox.push({
      type: "user",
      message: { role: "user", content: userContent(text, attachments) },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId,
    } as SDKUserMessage);
  }

  /**
   * The SDK exposes no `compact()`. Slash commands are dispatched by the CLI out of the prompt
   * channel itself — verified in `spikes/slash-dispatch.ts`, where `/compact` came back with
   * `turns=0 input_tokens=0` and no credential ever checked — so this is the same shape as
   * `applyEffort` above: the SDK has no method, and the wire format lives in one place.
   *
   * **A compaction is a turn.** It was not, on the reasoning that a local command is not billed and
   * that a turn here would leave the Steering Queue believing the session was busy. Both halves were
   * wrong, and one session's transcript showed it: summarising is a model call, so it billed $3.85,
   * and it held the session for three minutes — during which the queue's belief that nothing was
   * running was the false one. Everything downstream follows from saying so: a second compaction is
   * refused by the guard the host already has, a message typed meanwhile is queued in order rather
   * than pushed into this inbox ahead of the compaction, and three minutes of work becomes
   * abortable.
   *
   * `compacting` is what keeps the CLI's reply out of the transcript as an assistant message, which
   * is how it arrives — "Not enough messages to compact." would otherwise be attributed to the
   * model. Cleared on the `result` that closes the command, in every outcome.
   */
  async compact(instructions?: string): Promise<void> {
    if (this.disposed) throw new Error("Backend Session disposed");
    this.compacting = true;
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
    // Said before the CLI has been asked, because the whole point is that summarising takes a model
    // call: someone who sees nothing for ten seconds asks again.
    this.emit({ type: "compacting", active: true });
    this.inbox.push({
      type: "user",
      message: { role: "user", content: instructions ? `/compact ${instructions}` : "/compact" },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId,
    } as SDKUserMessage);
  }

  /**
   * `reloadSkills` and not `supportedCommands`, though the second is the one that sounds right.
   *
   * `supportedCommands()` returns everything the CLI knows — 52 of them in this repo — with no field
   * distinguishing a Skill from a built-in, so telling `/tdd` from `/heapdump` would mean a denylist
   * of names that rots on the next CLI release. `reloadSkills()` returns the 18 that are actually
   * Skills, which is the question being asked.
   *
   * That it also rescans the disk is the behaviour worth having: a human who has just written a
   * Skill opens the menu expecting to find it.
   */
  async skills(): Promise<Skill[]> {
    const { skills } = await this.stream.reloadSkills();
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    }));
  }

  /**
   * Hold the permission callback for an `AskUserQuestion` call until a human answers it.
   *
   * The returned promise is the turn: the SDK does not continue until it settles, so nothing here
   * may throw and no path may drop it. `spikes/ask-user-question.ts` established that the assistant
   * message carrying the `tool_use` block arrives *before* this does, so the `tool` Entry for
   * `askId` is already in the Presentation Transcript by the time the snapshot below joins it.
   *
   * A call posing no readable Question is denied rather than parked, because a picker with nothing
   * in it is a turn blocked on a box a human cannot answer.
   */
  private async ask(
    askId: string,
    input: Record<string, unknown>,
  ): Promise<
    { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }
  > {
    const questions = questionsOf(input);
    if (questions.length === 0) {
      return { behavior: "deny", message: `${ASK_TOOL} was called with no question. Continue without it.` };
    }

    return await new Promise((resolve) => {
      this.enquiries.hold(askId, questions, input, resolve);
      this.emit({ type: "enquiry", askId, questions, state: "asked" });
    });
  }

  async answerEnquiry(askId: string, answers: string[][]): Promise<boolean> {
    const questions = this.enquiries.describe(askId);
    if (!questions || !this.enquiries.answer(askId, answers)) return false;
    this.emit({ type: "enquiry", askId, questions, state: "answered", answers });
    return true;
  }

  /**
   * Settle every open Enquiry as unanswered, and say so in the transcript.
   *
   * Called from every path that ends a turn or a Backend Session. Denying rather than dropping is
   * what leaves the CLI's own conversation record complete — a real `tool_result` against the right
   * id — so a later Revive resumes onto a turn with no dangling `tool_use`.
   */
  private abandonEnquiries(why: string): void {
    for (const { askId, questions } of this.enquiries.abandonAll(why)) {
      this.emit({ type: "enquiry", askId, questions, state: "aborted" });
    }
  }

  async abort(): Promise<void> {
    // Before the interrupt, not after: the CLI is blocked on this callback, and an interrupt that
    // waits on the outstanding permission request would be waiting on something only this releases.
    this.abandonEnquiries("the turn was aborted");
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
    // Before the stream closes, while there is still something to deny into. A callback dropped by
    // the teardown leaves an unterminated tool call in the CLI's record, and the Agent Session this
    // belongs to is going Dormant — so that record is exactly what the next Revive resumes onto.
    this.abandonEnquiries("the session stopped");
    // Detached Subagents die with the CLI process, so nothing will ever notify them closed. The
    // Session Host records that from the transcript, the way it does a torn turn.
    this.subagents.abandon();
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
        // A stream that has failed will never deliver the `result` that would clear this, and a
        // session left suppressing would silently drop every assistant message after it.
        this.compacting = false;
        this.emit({ type: "compacting", active: false });
        // Same argument as the line above, for the other thing a dead stream will never deliver:
        // nothing is coming back to answer an open Enquiry, and a picker left on screen over a
        // session that has stopped is a question the human can answer into nothing.
        this.abandonEnquiries("the session failed");
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
          this.noteBootedEffort(sdkMessage.effort);
          return;
        }
        if (sdkMessage.subtype === "compact_boundary") {
          this.emit(describeCompaction(sdkMessage.compact_metadata));
          return;
        }
        // The only message carrying both ids, and so the only chance to learn which Subagent a
        // later notification is about. `noteTask` ignores a task that is not one's, which is what
        // keeps a backgrounded Bash or Monitor out of Subagent bookkeeping.
        if (sdkMessage.subtype === "task_started") {
          if (sdkMessage.tool_use_id) this.subagents.noteTask(sdkMessage.task_id, sdkMessage.tool_use_id);
          return;
        }
        // What actually closes a detached Subagent. `tool_use_id` where the SDK supplies it, the
        // task map where it does not.
        if (sdkMessage.subtype === "task_notification") {
          this.settleTask(sdkMessage.task_id, sdkMessage.tool_use_id, outcomeOf(sdkMessage.status));
          return;
        }
        // A task that died without notifying still has to stop its card spinning.
        if (sdkMessage.subtype === "task_updated") {
          const status = sdkMessage.patch.status;
          // No `tool_use_id` on this one, so the task map is the only way back to the Subagent.
          if (status) this.settleTask(sdkMessage.task_id, undefined, outcomeOf(status));
        }
        return;

      case "stream_event":
        // A local command's reply is not the model talking, so none of it may reach the transcript
        // as a partial assistant message either. See `compact`.
        if (this.compacting) return;
        this.ensureTurn(producerOf(sdkMessage));
        this.translateStreamEvent(sdkMessage.event, producerOf(sdkMessage));
        return;

      case "assistant": {
        // What the CLI says about a command it ran itself, said as Flow rather than as the
        // model. On a compaction that landed there is a `compacted` marker beside this; on one that
        // did not — "Not enough messages to compact." — this is the only account of it.
        if (this.compacting) {
          const said = textOf(sdkMessage.message.content);
          if (said) this.emit({ type: "notice", level: "info", text: said });
          return;
        }
        // The streamed copy and this one are the same Entry, and StreamedMessage is what guarantees
        // it. Tool calls stay here: they have nothing to do with the partial-message state.
        const producer = producerOf(sdkMessage);
        this.ensureTurn(producer);
        const finished = this.streamed.finish(producer, sdkMessage.message.id, sdkMessage.message.content);
        for (const event of finished) this.emit(event);
        for (const block of sdkMessage.message.content) {
          if (block.type !== "tool_use") continue;
          this.emit({
            type: "tool_started",
            callId: block.id,
            name: block.name,
            input: block.input,
            ...attribution(producer),
          });
          if (block.name !== SUBAGENT_TOOL) continue;
          const brief = briefOf(block.input);
          this.subagents.spawn(block.id, brief);
          this.emit({ type: "subagent", subagentId: block.id, ...brief, state: "running" });
        }
        return;
      }

      case "user": {
        const content = sdkMessage.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            const isError = block.is_error === true;
            this.emit({
              type: "tool_ended",
              callId: block.tool_use_id,
              result: block.content ?? "",
              isError,
              ...attribution(producerOf(sdkMessage)),
            });
            // A launch receipt, not an answer: the Subagent is only now starting work, so it gets
            // no terminal snapshot and its card stays running. What it does give up is its hold on
            // the turn, which is what keeps the Steering Queue live while it runs (ADR 0016).
            if (isAsyncLaunch(sdkMessage.tool_use_result)) {
              const released = this.subagents.background(block.tool_use_id);
              if (released) this.endTurn(released);
              continue;
            }
            // Before closeSubagent, which forgets the brief this snapshot needs.
            const brief = this.subagents.describe(block.tool_use_id);
            if (brief) {
              this.emit({
                type: "subagent",
                subagentId: block.tool_use_id,
                ...brief,
                state: isError ? "error" : "complete",
              });
            }
            this.closeSubagent(block.tool_use_id);
          }
        }
        return;
      }

      case "result": {
        // Cleared here and only here: a local command always ends in a result, whatever it made of
        // the request, so this is the one point that cannot leave the session suppressing forever.
        const wasCompacting = this.compacting;
        this.compacting = false;
        // Whatever it made of the request. A compaction that found nothing to do still has to stop
        // saying it is working, or the meter pulses until the session is disposed.
        if (wasCompacting) this.emit({ type: "compacting", active: false });
        // Read before the meter is asked for, so the two land on the client as one event.
        this.spend = addSpend(this.priorSpend, describeSpend(sdkMessage));
        // Worth asking even for a compaction, and especially then — occupancy has just fallen, and
        // that number is the whole reason anyone asked for one.
        void this.reportContextUsage();
        this.finishTurn(sdkMessage.subtype === "success" ? "complete" : "error");
        return;
      }

      default:
        return;
    }
  }

  private translateStreamEvent(event: StreamEvent, producer: string): void {
    const streamed = this.streamed.for(producer);
    if (event.type === "message_start") {
      streamed.start(event.message.id);
      return;
    }
    if (event.type !== "content_block_delta") return;

    const delta = event.delta;
    if (delta.type === "text_delta") this.emit(streamed.text(event.index, delta.text));
    else if (delta.type === "thinking_delta") this.emit(streamed.thinking(event.index, delta.thinking));
  }

  /**
   * Ask the CLI how much of the Conversation Context is spent.
   *
   * Never awaited by its callers: `translate` runs inside the message pump, so awaiting a control
   * request there would stop us reading the stream until the CLI answered and one hung request
   * would stall the Agent Session. The meter is chrome, so it may land just after `turn_ended`.
   *
   * Silent on rejection rather than emitting a `notice`. Only FLOW_CLAUDE_PATH and the SEA
   * build's PATH lookup can reach a CLI the SDK did not ship, and `getContextUsage` is a required
   * member of `Query` — so an older CLI rejects at runtime with no type warning, and a notice would
   * repeat every turn to say the meter has nothing to show.
   */
  private async reportContextUsage(): Promise<void> {
    let usage: SDKControlGetContextUsageResponse;
    try {
      usage = await this.stream.getContextUsage();
    } catch {
      return;
    }
    if (this.disposed) return;
    this.emit({
      type: "context_usage",
      ...describeContextUsage(usage),
      ...(this.spend === undefined ? {} : { spend: this.spend }),
    });
  }

  /**
   * End the turn a `result` reports, unless a Subagent is still open — see Subagents for why a
   * result cannot be attributed to one.
   *
   * Only this path defers. The pump's error path calls `endTurn` directly, because a stream that has
   * failed will never deliver the `tool_result` that would release a held end.
   */
  private finishTurn(reason: TurnEndReason): void {
    if (this.subagents.hold(reason)) return;
    this.endTurn(reason);
  }

  private closeSubagent(callId: string): void {
    const released = this.subagents.returned(callId);
    if (released) this.endTurn(released);
  }

  /**
   * Close the Subagent a settled task belongs to, if it is one's.
   *
   * Silent for a task that is not a Subagent's — a backgrounded Bash or Monitor settles through the
   * same messages, and neither has a card to close.
   */
  private settleTask(taskId: string, toolUseId: string | undefined, outcome: TurnEndReason | undefined): void {
    if (outcome === undefined) return;
    const callId = toolUseId ?? this.subagents.callIdOf(taskId);
    if (callId === undefined) return;
    const brief = this.subagents.describe(callId);
    if (brief === undefined) return;
    this.emit({ type: "subagent", subagentId: callId, ...brief, state: outcome });
    this.closeSubagent(callId);
  }

  /**
   * Open a turn for work the CLI started on its own.
   *
   * A backgrounded Subagent settling wakes the model without anyone prompting it: the CLI injects
   * the notification and the model speaks again, turns after the one that spawned it. Those words
   * are a turn — they cost money and occupy the session — and without one minted here they would
   * reduce into whatever turn happened to be last, or into none at all.
   *
   * Only for the Agent Session's own model. A detached Subagent goes on streaming its own rows after
   * the turn that launched it has ended, and minting a turn for those would occupy the session for
   * as long as it runs — which is the blocking this decision exists to avoid. ADR 0015 keeps
   * `producer` off `turn_started` for the same reason: a Subagent is not a turn and does not open one.
   */
  private ensureTurn(producer: string): void {
    if (producer !== "") return;
    if (this.turnId) return;
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
  }

  private endTurn(reason: TurnEndReason): void {
    const turnId = this.turnId;
    /*
     * Defensive, and should be unreachable: the turn cannot end while the CLI is blocked on a
     * permission callback, so anything still open here has already been abandoned by the path that
     * got us here. One line against the alternative, which is a picker on screen over a turn that
     * ended — a question with no way to answer it and no way to dismiss it.
     */
    this.abandonEnquiries("the turn ended");
    // Cleared whatever the outcome, so a held end cannot reach the turn after this one.
    this.subagents.clear();
    this.enquiries.clear();
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
    // Stated rather than read: `supportedModels()` reports effort and fast mode but nothing about
    // input modality, because every model this SDK serves can be shown an image. Hardcoded the way
    // `providers` and `compaction` are, and for the same reason — it is a fact about this backend
    // rather than an answer the SDK is willing to give.
    acceptsImages: true,
  };
}

/**
 * What the CLI's own context accounting means in Agent Event terms.
 *
 * `totalTokens` is occupancy, not one turn's spend: system prompt, tools, MCP tools, memory files
 * and the whole message history, cached parts included. The turn `usage` this used to read omitted
 * the cache reads that are most of a Claude Code session.
 *
 * `maxTokens` is the model's nominal window — measured at 200000 exactly on a 200K model, and it is
 * the denominator the CLI divides by for its own `percentage`. Not `autoCompactThreshold`, which is
 * the lower compaction trigger and would overstate how full the window is.
 */
/** One model's slice of a session's spend, as the SDK reports it on a `result`. */
type SdkModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  canonicalModel?: string;
};

/**
 * Everything billed for this Agent Session so far, per model.
 *
 * `modelUsage` is keyed by model and is cumulative for the session, so it is read rather than
 * accumulated — and because a Subagent runs under its own model entry, its spend is already in
 * here. That is the whole reason this exists: `getContextUsage` reports occupancy, and a
 * Subagent's conversation never occupies the parent's Conversation Context.
 *
 * Cache reads are counted in `tokens` and reported again in `cached`. They are billed, and on a long
 * session they are most of the count — so a total that omitted them would match no invoice, and a
 * total that hid them would overstate what the session actually cost to produce.
 *
 * Keyed by `canonicalModel` where the backend gives one, so the reading says `claude-haiku-4-5`
 * rather than `claude-haiku-4-5-20251001` — and so two versioned keys of one model add up.
 */
/**
 * Two readings of Spend added together, per model.
 *
 * Addition rather than replacement because each Backend Session reports only its own run: a Revive's
 * numbers are a continuation of the Agent Session's bill, not a correction to it.
 */
export function addSpend(before: Spend | undefined, after: Spend | undefined): Spend | undefined {
  if (!before) return after;
  if (!after) return before;
  const byModel = new Map<string, ModelSpend>();
  for (const model of [...before.models, ...after.models]) {
    const running = byModel.get(model.id) ?? { id: model.id, tokens: 0, cached: 0, costUSD: 0 };
    running.tokens += model.tokens;
    running.cached += model.cached;
    running.costUSD += model.costUSD;
    byModel.set(model.id, running);
  }
  const models = [...byModel.values()].sort((a, b) => b.costUSD - a.costUSD);
  return {
    tokens: before.tokens + after.tokens,
    cached: before.cached + after.cached,
    costUSD: before.costUSD + after.costUSD,
    models,
  };
}

export function describeSpend(result: { modelUsage?: Record<string, SdkModelUsage> }): Spend | undefined {
  const usage = result.modelUsage;
  if (!usage) return undefined;

  const byModel = new Map<string, ModelSpend>();
  for (const [key, model] of Object.entries(usage)) {
    const id = model.canonicalModel ?? key;
    const running = byModel.get(id) ?? { id, tokens: 0, cached: 0, costUSD: 0 };
    running.tokens +=
      model.inputTokens + model.outputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens;
    running.cached += model.cacheReadInputTokens;
    running.costUSD += model.costUSD;
    byModel.set(id, running);
  }

  // Costliest first: the reading is about where the money went, and a Subagent on a cheap model
  // should not push the model that did the work down the list.
  const models = [...byModel.values()].sort((a, b) => b.costUSD - a.costUSD);
  return {
    tokens: models.reduce((total, model) => total + model.tokens, 0),
    cached: models.reduce((total, model) => total + model.cached, 0),
    costUSD: models.reduce((total, model) => total + model.costUSD, 0),
    models,
  };
}

export function describeContextUsage(
  usage: Pick<SDKControlGetContextUsageResponse, "totalTokens" | "maxTokens">,
): { used: number; window: number } {
  return { used: usage.totalTokens, window: usage.maxTokens };
}

/**
 * The SDK's compaction boundary as the event a transcript records.
 *
 * The SDK compacts the Conversation Context on its own once the window fills, and until this
 * existed it did so silently — occupancy fell by two thirds between one turn and the next with
 * nothing to explain it. `trigger` is the SDK's own word for whether anyone asked, and it is kept
 * verbatim because both halves of it mean here exactly what they mean there.
 *
 * `post_tokens` is optional upstream, so `after` is omitted rather than defaulted: a compaction
 * reported as ending at zero tokens would read as having thrown the conversation away.
 */
/** The text of an assistant message, for the one case that is not the model speaking. See `compact`. */
function textOf(content: Extract<SDKMessage, { type: "assistant" }>["message"]["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("")
    .trim();
}

type CompactBoundary = Extract<SDKMessage, { type: "system"; subtype: "compact_boundary" }>["compact_metadata"];

export function describeCompaction(
  // `post_tokens` is widened to accept an explicit undefined as well as an absent key, which
  // `exactOptionalPropertyTypes` otherwise keeps apart. A caller reading it off a message it did not
  // build should not have to care which of the two it has.
  metadata: Pick<CompactBoundary, "trigger" | "pre_tokens"> & { post_tokens?: number | undefined },
): Extract<BackendEvent, { type: "compacted" }> {
  return {
    type: "compacted",
    trigger: metadata.trigger,
    before: metadata.pre_tokens,
    ...(metadata.post_tokens === undefined ? {} : { after: metadata.post_tokens }),
  };
}

/**
 * One user turn's content: a plain string when there is nothing but text, and a block array when
 * there is more.
 *
 * The string is kept for the common turn rather than always sending a one-element array, because a
 * `content` this backend has sent as a string since it was written is not worth re-shaping for a
 * feature most turns do not use.
 *
 * Images lead. The docs prefer image-then-text and it costs nothing to honour here, where the text
 * is a question *about* what precedes it.
 */
export function userContent(
  text: string,
  attachments?: PromptAttachment[],
): SDKUserMessage["message"]["content"] {
  if (!attachments?.length) return text;
  return [
    ...attachments.map((attachment) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachment.mediaType, data: attachment.data },
    })),
    { type: "text" as const, text },
  ];
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
