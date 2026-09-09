import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendCreateOptions, BackendSession, PromptAttachment } from "../types.ts";
import type {
  BackendEvent,
  Capabilities,
  EffortLevel,
  PermissionDecision,
  Question,
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
  // True by default, like `subagents` and unlike `compaction`: an Enquiry is something almost every
  // host and reducer test needs to be able to drive, and the cannot-ask case stays reachable through
  // the overrides for the handful that assert on a backend which has no channel to ask through.
  enquiries: true,
  // True for the reason `enquiries` is: a Permission Prompt is something the host, reducer and
  // durability tests all need to drive, and the cannot-ask case stays reachable through the
  // overrides for the few that assert on a backend which never asks.
  permissions: true,
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
  /** What this session was told the machine already authorises, for asserting the read-at-create. */
  readonly standingAuthorisations: readonly string[];
  /** Every Subagent begun in this session, in the style of `prompts`. */
  readonly subagents: FakeSubagent[] = [];
  /** Every Enquiry asked in this session, open or not, in the style of `prompts`. */
  readonly enquiries: Array<{ askId: string; questions: Question[] }> = [];
  /** What was answered, so a test can assert what reached the backend rather than what it emitted. */
  readonly answered: Array<{ askId: string; answers: string[][] }> = [];
  /** Every Permission Prompt raised in this session, open or not, in the style of `enquiries`. */
  readonly permissionPrompts: Array<{ callId: string; tool: string }> = [];
  /** What was decided, so a test can assert what reached the backend rather than what it emitted. */
  readonly decided: Array<{ callId: string; decision: PermissionDecision }> = [];
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
   * Present only when this session declares it can ask, for the reason `compact` is: the conformance
   * contract asserts the flag and the method say the same thing, or a client that hides its control
   * on the flag will call a method that is not there.
   */
  answerEnquiry?: (askId: string, answers: string[][]) => Promise<boolean>;

  /** Present only when this session declares it can be asked before it acts. See `answerEnquiry`. */
  answerPermission?: (callId: string, decision: PermissionDecision) => Promise<boolean>;

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
    this.standingAuthorisations = options.standingAuthorisations ?? [];
    if (this.capabilities.enquiries) {
      this.answerEnquiry = async (askId: string, answers: string[][]) => {
        const open = this.enquiries.find((enquiry) => enquiry.askId === askId);
        // Answered twice is an ordinary race, not a fault — the host turns the false into a refusal.
        if (!open || this.answered.some((seen) => seen.askId === askId)) return false;
        this.answered.push({ askId, answers });
        this.emit({ type: "enquiry", askId, questions: open.questions, state: "answered", answers });
        this.emit({ type: "tool_ended", callId: askId, result: "The user answered.", isError: false });
        return true;
      };
    }
    if (this.capabilities.permissions) {
      this.answerPermission = async (callId: string, decision: PermissionDecision) => {
        const open = this.permissionPrompts.find((prompt) => prompt.callId === callId);
        // Decided twice is an ordinary race, not a fault — the host turns the false into a refusal,
        // and a false is also what tells it to persist nothing.
        if (!open || this.decided.some((seen) => seen.callId === callId)) return false;
        this.decided.push({ callId, decision });
        this.emit({ type: "permission", callId, tool: open.tool, state: "decided", decision });
        // A denial still ends the tool call, which is the whole reason a Deny is not an Abort.
        this.emit({
          type: "tool_ended",
          callId,
          result: decision === "deny" ? `${open.tool} is not enabled for this session.` : "ok",
          isError: decision === "deny",
        });
        return true;
      };
    }
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

  /**
   * Test affordance: open a turn nobody prompted for.
   *
   * What a real adapter mints when a backgrounded Subagent settles and the CLI wakes the model on
   * its own (ADR 0016). No `user_message` precedes it, which is the whole point: the Session Host
   * has to take occupancy from the event rather than from having dispatched.
   */
  startTurn(): void {
    if (this.turnId) return;
    this.turnId = randomUUID();
    this.emit({ type: "turn_started", turnId: this.turnId });
  }

  /** Test affordance: end the turn in flight. */
  completeTurn(reason: "complete" | "aborted" | "error" = "complete"): void {
    if (!this.turnId) return;
    const turnId = this.turnId;
    this.turnId = undefined;
    this.emit({ type: "turn_ended", turnId, reason });
  }

  /**
   * Ask the human something, as a real backend would: the tool call that asks, and the Enquiry
   * snapshot sharing its id.
   *
   * Both, because both is what a real adapter produces — an Enquiry whose tool call never appeared
   * is a shape nothing downstream should have to cope with, and the front-ends suppress the tool row
   * by pairing it with this one. Returns the `askId` so a test can answer it.
   *
   * Deliberately, `completeTurn()` does **not** close an open Enquiry. Leaving one open is the torn
   * fixture the Session Host has to cope with, and it is the contract `beginSubagent` already sets.
   */
  ask(questions: Question[]): string {
    const askId = randomUUID();
    this.enquiries.push({ askId, questions });
    this.emit({ type: "tool_started", callId: askId, name: "AskUserQuestion", input: { questions } });
    this.emit({ type: "enquiry", askId, questions, state: "asked" });
    return askId;
  }

  /**
   * Raise a Permission Prompt, as a real backend would: the tool call awaiting authorisation, and
   * the prompt snapshot sharing its id.
   *
   * Both, and here the tool call matters more than it does for an Enquiry — the front-ends fold the
   * decision *onto* that row rather than adding one of their own, so a prompt whose call never
   * appeared is a prompt with nowhere to render. Returns the `callId` so a test can decide it.
   *
   * `completeTurn()` deliberately does not close an open one: that is the torn fixture the Session
   * Host has to cope with, the contract `ask` and `beginSubagent` already set.
   */
  askPermission(tool: string, input: unknown = {}): string {
    const callId = randomUUID();
    this.permissionPrompts.push({ callId, tool });
    this.emit({ type: "tool_started", callId, name: tool, input });
    this.emit({ type: "permission", callId, tool, state: "asked" });
    return callId;
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
  launched = false;

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

  /**
   * Background it: return the spawning tool call now, and go on running (ADR 0016).
   *
   * The launch receipt, which is what a real adapter reads to tell a backgrounded Subagent from a
   * finished one. Emits no snapshot — the card stays running — so the turn may end with this
   * Subagent still open, and `finish` closes it however many turns later.
   */
  launch(): void {
    if (this.launched || this.finished) return;
    this.launched = true;
    this.emit({
      type: "tool_ended",
      callId: this.subagentId,
      result: `${this.name} launched in the background`,
      isError: false,
    });
  }

  finish(reason: "complete" | "aborted" | "error" = "complete"): void {
    if (this.finished) return;
    this.finished = true;
    this.snapshot({ state: reason });
    // The tool result is what returns a foreground Subagent, the same way a real backend closes one.
    // A backgrounded one already returned it at launch, and returning it twice is a shape no adapter
    // produces.
    if (this.launched) return;
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
export type FakeCapabilityOverrides = Partial<
  Pick<Capabilities, "compaction" | "fork" | "enquiries" | "permissions">
>;

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
