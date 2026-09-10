import type { Producer } from "../../protocol/events.ts";

/** What a Background Call is, as its own `tool_use` block reported it. */
export type BackgroundBrief = {
  /** The tool's name. Every later message about the Call carries ids and no name (ADR 0021). */
  tool: string;
  /** The Subagent that made the call, where one did. Stored so every snapshot agrees. */
  producer?: Producer;
};

/**
 * The tool calls this turn has made, and the ones the CLI is running past it.
 *
 * Its own module rather than fields on ClaudeSession for the reason `Subagents` gives: that session
 * cannot be constructed without spawning a Claude process, so none of this would be reachable from
 * a test there. Apart from `Subagents` rather than inside it because `Subagents.noteTask` refusing a
 * `callId` it does not know is what keeps a backgrounded `Bash` out of Subagent bookkeeping without
 * a list of task types to maintain (ADR 0016) — and that refusal is only a boundary while there are
 * two objects for it to be between. `Subagents` is unedited by this feature, which is the evidence.
 *
 * **It holds nothing, and there is nowhere to put a hold.** A Background Call is not occupancy
 * (ADR 0016): the model that made it is Idle and the Steering Queue must stay live. `Subagents.hold`
 * has no counterpart here by construction rather than by discipline, so there is no field for a
 * later edit to start holding a turn with.
 */
export class BackgroundCalls {
  /**
   * Every tool call this turn announced, by id, so `task_started` can be told what it started.
   *
   * Every call rather than the ones we recognise, which is what makes detection structural: the name
   * is only knowable from the `tool_use` block, and recording only names we expect to background is
   * the tool-name allowlist ADR 0021 refuses.
   *
   * Nothing prunes a foreground call from here as its result arrives, because nothing could promote
   * one afterwards — a `task_started` names the callId it started, so a call that never gets one is
   * never reachable. `clear()` at the turn end is the whole of the bound, and one turn's calls is
   * the whole of the cost.
   */
  private readonly pending = new Map<string, BackgroundBrief>();
  /** Launched and unsettled. Outlives its turn; dies with its Backend Session. */
  private readonly open = new Map<string, BackgroundBrief>();
  /**
   * `task_id` to `callId`.
   *
   * Not a convenience: `task_updated` is the message that reports a Call killed rather than
   * finished, and it carries no `tool_use_id` at all, so this map is the only way back to the id
   * space (ADR 0015).
   */
  private readonly tasks = new Map<string, string>();

  /** Remember a tool call, in case the CLI turns out to be running it in the background. */
  called(callId: string, brief: BackgroundBrief): void {
    this.pending.set(callId, brief);
  }

  /**
   * Promote an announced call to an open Background Call, and answer with what it is.
   *
   * Undefined for a call this never saw announced — which gets no card, rather than one named after
   * a guess — and for one already open, so the CLI repeating `task_started` cannot emit a second
   * launch snapshot or double-count the Call.
   */
  launch(callId: string): BackgroundBrief | undefined {
    const brief = this.pending.get(callId);
    if (brief === undefined) return undefined;
    this.pending.delete(callId);
    this.open.set(callId, brief);
    return brief;
  }

  /** What an open Background Call is, or undefined for a call that is not one. */
  describe(callId: string): BackgroundBrief | undefined {
    return this.open.get(callId);
  }

  /**
   * Remember which call a task id belongs to. Refuses a call this has never heard of.
   *
   * Accepts one still only announced as well as one already open, because `task_started` arrives
   * *before* the launching `tool_result` — captured at 9.2s against 9.3s in
   * `spikes/background-call-messages.ts` — so at the moment this is called the call is usually
   * `pending` and not yet `open`.
   */
  noteTask(taskId: string, callId: string): void {
    if (!this.pending.has(callId) && !this.open.has(callId)) return;
    this.tasks.set(taskId, callId);
  }

  /** The Background Call a settled task is about, or undefined when the task is not one's. */
  callIdOf(taskId: string): string | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Record that a Background Call settled, answering with what it was so the snapshot can name it.
   *
   * Undefined the second time, which is load-bearing rather than defensive: a Call settles through
   * `task_updated` *and* `task_notification`, both arriving in the same tick with the same outcome
   * (captured in the spike), and a caller that emitted a terminal snapshot for each would write two.
   */
  settled(callId: string): BackgroundBrief | undefined {
    const brief = this.open.get(callId);
    if (brief === undefined) return undefined;
    this.forgetTasks(callId);
    this.open.delete(callId);
    return brief;
  }

  /**
   * Forget this turn's announced calls.
   *
   * Open Background Calls and their task ids deliberately survive: one outlives the turn that made
   * it, and the snapshot closing it is emitted turns later from the brief kept here.
   */
  clear(): void {
    this.pending.clear();
  }

  /** Forget open Calls too, for a Backend Session being taken away. They are children of it. */
  abandon(): void {
    this.clear();
    this.open.clear();
    this.tasks.clear();
  }

  private forgetTasks(callId: string): void {
    for (const [taskId, owner] of this.tasks) {
      if (owner === callId) this.tasks.delete(taskId);
    }
  }
}
