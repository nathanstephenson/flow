import type { TurnEndReason } from "../../protocol/events.ts";

/**
 * The Delegations open in one turn, and the turn end held back while any of them is.
 *
 * `SDKResultMessage` carries no `parent_tool_use_id` at SDK 0.3.247, so a `result` emitted for a
 * subagent cannot be told apart from the one that ends the turn. Ending on the first would clear
 * `turnInFlight` in the Session Host, and the Steering Queue would dispatch the next message into a
 * turn that is still running — two messages in one turn, which reads as the agent ignoring the first.
 *
 * Its own module rather than three fields on ClaudeSession because that session cannot be constructed
 * without spawning a Claude process, so none of this would be reachable from a test there — the same
 * reason StreamedMessage lives apart.
 */
export class Delegations {
  private readonly open = new Set<string>();
  private held: TurnEndReason | undefined;

  spawn(callId: string): void {
    this.open.add(callId);
  }

  /**
   * Record that a Delegation returned. Answers with the turn end that was waiting on it, and only
   * when it was the last one open — so a turn with three Delegations ends once, after the third.
   */
  returned(callId: string): TurnEndReason | undefined {
    if (!this.open.delete(callId)) return undefined;
    if (this.open.size > 0) return undefined;
    const held = this.held;
    this.held = undefined;
    return held;
  }

  /**
   * Offer a turn end. True when it was held because a Delegation is still open, false when the caller
   * should end the turn now.
   */
  hold(reason: TurnEndReason): boolean {
    if (this.open.size === 0) return false;
    this.held = reason;
    return true;
  }

  /** Forget everything, so a held end cannot reach the turn after this one. */
  clear(): void {
    this.open.clear();
    this.held = undefined;
  }
}
