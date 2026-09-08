import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendCreateOptions, BackendSession, PromptAttachment } from "../types.ts";
import type {
  BackendEvent,
  Capabilities,
  EffortLevel,
  Skill,
  Spend,
  SubagentState,
  SubagentWait,
} from "../../protocol/events.ts";
import { clampEffort } from "../effort.ts";

// Two models on purpose: one with an effort control and one without, which is the split every
// real backend has (Claude's haiku offers no effort) and the one clients must cope with. The same
// two carry the Attachment split for the same reason — pi's registry has models that cannot be
// shown an image, so a client that assumes every model can is a client with a bug nothing here
// would have caught.
const FAKE_CAPABILITIES: Capabilities = {
  providers: ["fake"],
  models: [
    { id: "fake-1", provider: "fake", label: "Fake 1", effortLevels: ["low", "medium", "high"], acceptsImages: true },
    { id: "fake-2", provider: "fake", label: "Fake 2" },
  ],
  compaction: false,
  fork: false,
  subagents: true,
};

/**
 * A Backend Adapter with no model behind it, driven entirely by the test.
 *
 * Turns do not end on their own — the test calls `completeTurn()`. That makes queue and lifecycle
 * assertions deterministic instead of timing-dependent.
 */
export class FakeSession implements BackendSession {
  readonly capabilities: Capabilities;
  readonly prompts: string[] = [];
  /** Every compaction asked of this session, with whatever instructions came with it. */
  readonly compactions: Array<string | undefined> = [];
  /** Parallel to `prompts`, so a test can assert what reached the backend beside each text. */
  readonly promptedAttachments: PromptAttachment[][] = [];
  readonly resumedFrom: string | undefined;
  /** What this session was told the Agent Session had already spent, for asserting a Revive. */
  readonly priorSpend: Spend | undefined;
  /** Every Subagent begun in this session, in the style of `prompts`. */
  readonly subagents: FakeSubagent[] = [];
  modelId: string;
  effort: EffortLevel | undefined;
  disposed = false;

  private readonly emit: (event: BackendEvent) => void;
  private turnId: string | undefined;
  private wantedEffort: EffortLevel | undefined;

  /**
   * Present only when this session declares it can compact, which is what the conformance contract
   * asserts of every adapter: the flag and the method have to say the same thing, or a client that
   * hides its control on the flag will call a method that is not there.
   */
  compact?: (instructions?: string) => Promise<void>;

  /**
   * Leaves a requested compaction running — the turn opens and never closes.
   *
   * Real compactions take minutes, and everything that goes wrong around one goes wrong *during*
   * it: a message racing ahead of it, a second request arriving on top of it. A fake that finishes
   * before it returns cannot reproduce any of that.
   */
  holdCompaction = false;

  constructor(options: BackendCreateOptions, overrides: FakeCapabilityOverrides = {}) {
    this.capabilities = { ...FAKE_CAPABILITIES, ...overrides };
    if (this.capabilities.compaction) {
      // Opens and closes a turn, because a compaction is one: it spends money and holds the backend
      // while it runs, and the Steering Queue only orders messages correctly if it is told so.
      this.compact = async (instructions?: string) => {
        this.compactions.push(instructions);
        this.turnId = randomUUID();
        this.emit({ type: "turn_started", turnId: this.turnId });
        if (this.holdCompaction) return;
        this.emit({ type: "compacted", trigger: "manual", before: 1_000, after: 100 });
        this.completeTurn("complete");
      };
    }
    this.emit = options.emit;
    this.modelId = options.modelId ?? "fake-1";
    this.resumedFrom = options.resume;
    this.priorSpend = options.priorSpend;
    this.emit({ type: "model_changed", model: { id: this.modelId, provider: "fake" } });
    if (options.effort) void this.setEffort(options.effort);
  }

  resumeToken(): string | undefined {
    return "fake-resume";
  }

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    this.prompts.push(text);
    this.promptedAttachments.push(attachments ?? []);
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
  }

  async abort(): Promise<void> {
    this.completeTurn("aborted");
  }

  async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    this.emit({ type: "model_changed", model: { id: modelId, provider: "fake" } });
    if (this.wantedEffort) await this.setEffort(this.wantedEffort);
  }

  /**
   * Two, and one of them takes arguments — the split a menu has to render, the same way the two
   * models here carry the Effort and Attachment splits. Reassigned by a test that wants a different
   * catalogue, or emptied by one that wants none.
   */
  skillList: Skill[] = [
    { name: "tdd", description: "Red, green, refactor" },
    { name: "review", description: "Review the diff", argumentHint: "[<pr#>|<branch>]" },
  ];

  async skills(): Promise<Skill[]> {
    return this.skillList;
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.wantedEffort = effort;
    const levels = FAKE_CAPABILITIES.models.find((model) => model.id === this.modelId)?.effortLevels;
    const level = clampEffort(effort, levels);
    if (!level) return;
    this.effort = level;
    this.emit({ type: "effort_changed", effort: level });
  }


  async dispose(): Promise<void> {
    this.disposed = true;
  }

  /** Test affordance: emit assistant text for the turn in flight. */
  say(text: string, final = true): void {
    this.emit({ type: "message", id: `msg-${this.prompts.length}`, text, final });
  }

  /** Test affordance: report Spend, which is how a Revive gets something to carry forward. */
  reportSpend(spend: Spend): void {
    this.emit({ type: "context_usage", used: 10, window: 100, spend });
  }

  /** Test affordance: emit a complete tool call. */
  useTool(name: string, input: unknown, result: unknown, isError = false): string {
    const callId = randomUUID();
    this.emit({ type: "tool_started", callId, name, input });
    this.emit({ type: "tool_ended", callId, result, isError });
    return callId;
  }

  /** Test affordance: end the turn in flight. */
  completeTurn(reason: "complete" | "aborted" | "error" = "complete"): void {
    if (!this.turnId) return;
    const turnId = this.turnId;
    this.turnId = undefined;
    this.emit({ type: "turn_ended", turnId, reason });
  }

  /**
   * Test affordance: begin a Subagent, and get a handle whose emissions are attributed to it.
   *
   * The only way a test can produce an interleaved parent-and-child stream, which is the case that
   * breaks anything assuming one producer per turn. Emits the spawning `tool_started` as well as the
   * first snapshot, because ADR 0015 has the two share an id and a Subagent whose tool call never
   * appeared would be a shape no real backend can produce.
   *
   * `completeTurn` deliberately does not close an open Subagent: leaving one running is the
   * torn-Subagent fixture, and the Session Host is what has to cope with it.
   */
  beginSubagent(name: string, description?: string): FakeSubagent {
    const subagentId = randomUUID();
    const subagent = new FakeSubagent(subagentId, name, description, this.emit);
    this.subagents.push(subagent);
    this.emit({ type: "tool_started", callId: subagentId, name: "Agent", input: { name, description } });
    subagent.snapshot({ state: "running" });
    return subagent;
  }
}

/**
 * One Subagent under test. Every emission carries `producer`, so a test can interleave a parent's
 * stream with a child's and assert neither takes the other's Entry.
 */
export class FakeSubagent {
  readonly subagentId: string;
  readonly name: string;
  readonly description: string | undefined;
  finished = false;

  private readonly emit: (event: BackendEvent) => void;
  /** Bumped when a message finalises, so a partial and its finished half share one id. */
  private messageIndex = 0;

  constructor(
    subagentId: string,
    name: string,
    description: string | undefined,
    emit: (event: BackendEvent) => void,
  ) {
    this.subagentId = subagentId;
    this.name = name;
    this.description = description;
    this.emit = emit;
  }

  /**
   * Attributed assistant text. The id is stable until the message finalises, because a partial and
   * its finished half landing on different ids is the stranded-caret bug — a shape no real adapter
   * may produce, so the double must not either.
   */
  say(text: string, final = true): void {
    this.emit({
      type: "message",
      id: `${this.subagentId}-msg-${this.messageIndex}`,
      text,
      final,
      producer: { subagentId: this.subagentId },
    });
    if (final) this.messageIndex += 1;
  }

  /** An attributed tool call — the subagent's Read, not the parent's. */
  useTool(name: string, input: unknown, result: unknown, isError = false): string {
    const callId = randomUUID();
    const producer = { subagentId: this.subagentId };
    this.emit({ type: "tool_started", callId, name, input, producer });
    this.emit({ type: "tool_ended", callId, result, isError, producer });
    return callId;
  }

  /** Move to waiting, naming what is being waited on. Snapshot semantics: callable repeatedly. */
  wait(on: SubagentWait): void {
    this.snapshot({ state: "waiting", on });
  }

  /** Back to running from waiting, without ending. */
  resume(): void {
    this.snapshot({ state: "running" });
  }

  finish(reason: "complete" | "aborted" | "error" = "complete"): void {
    if (this.finished) return;
    this.finished = true;
    this.snapshot({ state: reason });
    // The tool result is what returns a Subagent, the same way a real backend closes one.
    this.emit({ type: "tool_ended", callId: this.subagentId, result: `${this.name} finished`, isError: reason === "error" });
  }

  /** @internal — used by FakeSession to emit the opening snapshot. */
  snapshot(state: SubagentState): void {
    this.emit({
      type: "subagent",
      subagentId: this.subagentId,
      name: this.name,
      ...(this.description === undefined ? {} : { description: this.description }),
      ...state,
    });
  }
}

/**
 * What this fake claims it can do, for the tests that need a backend on the other side of a
 * capability gate.
 *
 * Off by default so the existing suite keeps asserting against a backend that serves neither, which
 * is the case clients must hide a control for. A test that wants the other side asks for it.
 */
export type FakeCapabilityOverrides = Partial<Pick<Capabilities, "compaction" | "fork">>;

export class FakeBackend implements AgentBackend {
  readonly name = "fake";
  readonly sessions: FakeSession[] = [];

  // A plain field, not a constructor parameter property: `node --experimental-strip-types` erases
  // types and cannot emit the assignment one implies.
  private readonly overrides: FakeCapabilityOverrides;

  constructor(overrides: FakeCapabilityOverrides = {}) {
    this.overrides = overrides;
  }

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    const session = new FakeSession(options, this.overrides);
    this.sessions.push(session);
    return session;
  }

  get latest(): FakeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("No fake session created yet");
    return session;
  }
}
