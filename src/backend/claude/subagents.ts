import type { TurnEndReason } from "../../protocol/events.ts";

/** What a Subagent was called and asked to do, as the spawning tool call reported it. */
export type SubagentBrief = { name: string; description?: string };

/**
 * The Subagents open in one turn, the turn end held back while any of them is, and the backgrounded
 * ones that go on running past it.
 *
 * `SDKResultMessage` carries no `parent_tool_use_id` at SDK 0.3.247, so a `result` emitted for a
 * subagent cannot be told apart from the one that ends the turn. (ADR 0016 records that CLI 2.1.247
 * emits no such result in the first place — one per parent turn and no more — so the holding below
 * is belt to the bookkeeping's braces. Kept because that is one version on the happy path, and says
 * nothing about a nested Subagent, an interrupt, or an error.) Ending on the first would clear
 * `turnInFlight` in the Session Host, and the Steering Queue would dispatch the next message into a
 * turn that is still running — two messages in one turn, which reads as the agent ignoring the first.
 *
 * Its own module rather than three fields on ClaudeSession because that session cannot be constructed
 * without spawning a Claude process, so none of this would be reachable from a test there — the same
 * reason StreamedMessage lives apart.
 */
export class Subagents {
  private readonly open = new Map<string, SubagentBrief>();
  /**
   * The Subagents running detached, which are open without holding anything (ADR 0016).
   *
   * Apart from `open` rather than a flag on the brief because the two are asked different questions:
   * `open` answers "may this turn end", and this answers "whose card is still running". Only the
   * first is turn-scoped, which is why `clear` empties one and keeps the other.
   */
  private readonly detached = new Map<string, SubagentBrief>();
  /**
   * `task_id` to the `callId` that spawned it, for the `task_notification` that closes a detached
   * Subagent — it is the only message carrying the task id alone, and ADR 0015 keeps `callId` the
   * one id space.
   */
  private readonly tasks = new Map<string, string>();
  private held: TurnEndReason | undefined;

  spawn(callId: string, brief: SubagentBrief): void {
    this.open.set(callId, brief);
  }

  /**
   * What a still-open Subagent was called and asked to do, or undefined for a tool call that is
   * not one. A snapshot carries the whole state including the name, so the terminal one emitted when
   * a Subagent returns needs this back — the returning `tool_result` carries only an id.
   */
  describe(callId: string): SubagentBrief | undefined {
    return this.open.get(callId) ?? this.detached.get(callId);
  }

  /**
   * Record that a Subagent was backgrounded, so it stops holding the turn without ending.
   *
   * Answers the same question `returned` does — the turn end now free to fire — because a launch
   * receipt releases a held end for exactly the reason a real one does: nothing else is waiting.
   */
  background(callId: string): TurnEndReason | undefined {
    const brief = this.open.get(callId);
    if (brief === undefined) return undefined;
    this.open.delete(callId);
    this.detached.set(callId, brief);
    return this.release();
  }

  /** Remember which Subagent a task id belongs to. Ignores a task that is not one's. */
  noteTask(taskId: string, callId: string): void {
    if (this.describe(callId) === undefined) return;
    this.tasks.set(taskId, callId);
  }

  /** The Subagent a `task_notification` is about, or undefined when the task is not a Subagent's. */
  callIdOf(taskId: string): string | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Record that a Subagent returned. Answers with the turn end that was waiting on it, and only
   * when it was the last one open — so a turn with three Subagents ends once, after the third.
   *
   * A detached one releases nothing: it gave up its hold when it was backgrounded, and the turn it
   * was spawned in has long since ended.
   */
  returned(callId: string): TurnEndReason | undefined {
    this.forgetTasks(callId);
    if (this.detached.delete(callId)) return undefined;
    if (!this.open.delete(callId)) return undefined;
    return this.release();
  }

  /**
   * Offer a turn end. True when it was held because a Subagent is still open, false when the caller
   * should end the turn now.
   */
  hold(reason: TurnEndReason): boolean {
    if (this.open.size === 0) return false;
    this.held = reason;
    return true;
  }

  /**
   * Forget this turn's bookkeeping, so a held end cannot reach the turn after this one.
   *
   * Detached Subagents and their task ids deliberately survive: one outlives the turn that spawned
   * it (ADR 0016), and the snapshot closing it is emitted turns later from the brief kept here.
   */
  clear(): void {
    this.open.clear();
    this.held = undefined;
  }

  /**
   * Forget detached Subagents too, for a Backend Session being taken away.
   *
   * They die with the CLI process, so nothing will ever notify them closed — the Session Host
   * records that as `aborted` from the transcript, the way it does a torn turn.
   */
  abandon(): void {
    this.clear();
    this.detached.clear();
    this.tasks.clear();
  }

  private release(): TurnEndReason | undefined {
    if (this.open.size > 0) return undefined;
    const held = this.held;
    this.held = undefined;
    return held;
  }

  private forgetTasks(callId: string): void {
    for (const [taskId, owner] of this.tasks) {
      if (owner === callId) this.tasks.delete(taskId);
    }
  }
}
