import type { PermissionDecision } from "../../protocol/events.ts";

/**
 * How a pending Permission Prompt is settled: an allowed call, or a denial the model can read and
 * carry on from.
 *
 * The same two outcomes `Settle` in ./enquiries.ts is typed as, and for the same reason — nothing
 * here ever rejects, and saying so in the type is what makes it unmissable.
 *
 * `interrupt` is deliberately absent from the deny branch though the SDK offers it. A human's Deny
 * ends one tool call with a message the model continues from; interrupting would abort the turn, and
 * Deny is not Abort. Someone will conflate the two, so the type refuses to let them.
 */
export type Settle = (
  result:
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string },
) => void;

type Pending = {
  tool: string;
  /** The call's own arguments, handed straight back on an allow — never altered, never inspected. */
  input: Record<string, unknown>;
  settle: Settle;
};

/**
 * The Permission Prompts open in one turn, the callbacks held for them, and what the human has
 * already refused.
 *
 * A sibling of `PendingEnquiries`, and the rule is the same one: the Claude SDK does not continue
 * until `canUseTool` settles, so **every path must settle it**. A rejected or dropped callback leaves
 * the CLI with a `tool_use` it never resolved, the turn cannot end, and the Agent Session is pinned
 * in `running` with no key that unpins it. A *denial* is a real `tool_result` and leaves the
 * conversation complete, so a later Revive resumes onto a turn with nothing dangling.
 *
 * What it adds over its sibling is `refused`: an Enquiry is asked once, but a model that wanted a
 * tool typically wants it several times in a turn, and asking again the moment someone said no is
 * how a composer gets pinned on the same question while the model rephrases. So a no is remembered
 * for the rest of the turn and answered silently — with the adapter's own neutral refusal rather
 * than "the human declined", because the model is being unblocked, not corrected, and one told a
 * person refused it will spend the turn negotiating.
 *
 * Turn-scoped and no wider. A no was about what was being attempted, not about the tool forever;
 * `clear()` drops it at the end of the turn, and the Always decision is the only thing here that
 * outlives one.
 *
 * Its own module rather than fields on ClaudeSession because that session cannot be constructed
 * without spawning a Claude process, so none of this would be reachable from a test there.
 */
export class PendingPermissions {
  private readonly open = new Map<string, Pending>();
  private readonly refused = new Set<string>();

  /** Park a callback against the call awaiting authorisation. `callId` is the SDK's `toolUseID`. */
  hold(callId: string, tool: string, input: Record<string, unknown>, settle: Settle): void {
    this.open.set(callId, { tool, input, settle });
  }

  /** Which tool an open prompt is about, or undefined for one already settled. */
  describe(callId: string): string | undefined {
    return this.open.get(callId)?.tool;
  }

  /** Whether this tool has already been refused in this turn, and so must not be asked about again. */
  isRefused(tool: string): boolean {
    return this.refused.has(tool);
  }

  /**
   * Settle an open prompt with a human's decision.
   *
   * False when there was nothing open under this id, which is an ordinary race — a second click, or a
   * decision made against a transcript older than the Backend Session serving it. The caller reports
   * it as a refusal rather than an error, and nothing is persisted for it.
   */
  decide(callId: string, decision: PermissionDecision): boolean {
    const pending = this.open.get(callId);
    if (!pending) return false;
    this.open.delete(callId);
    if (decision === "deny") {
      this.refused.add(pending.tool);
      pending.settle({ behavior: "deny", message: refusal(pending.tool) });
      return true;
    }
    pending.settle({ behavior: "allow", updatedInput: pending.input });
    return true;
  }

  /**
   * Settle an open prompt as unauthorised, denying the tool with something the model can act on.
   * Answers with the tool it was about, so the caller can emit the terminal snapshot for it.
   */
  abandon(callId: string, why: string): string | undefined {
    const pending = this.open.get(callId);
    if (!pending) return undefined;
    this.open.delete(callId);
    pending.settle({ behavior: "deny", message: abandonment(pending.tool, why) });
    return pending.tool;
  }

  /** Abandon everything open, and say what was abandoned so each gets its terminal snapshot. */
  abandonAll(why: string): { callId: string; tool: string }[] {
    return [...this.open.keys()].flatMap((callId) => {
      const tool = this.abandon(callId, why);
      return tool ? [{ callId, tool }] : [];
    });
  }

  /**
   * Forget everything without settling anything, and forget what was refused.
   *
   * Beside `PendingEnquiries.clear()` and carrying its warning verbatim: this is **not** how a turn
   * ends. Anything still open must be abandoned first, or its callback is dropped and the CLI waits
   * forever. What makes it safe is that the callbacks are already gone — the process behind them is
   * down, or the turn that held them is over.
   */
  clear(): void {
    this.open.clear();
    this.refused.clear();
  }
}

/**
 * What the model is told when a human said no.
 *
 * Verbatim the adapter's own pre-existing refusal, and that is the point: the model learns the tool
 * is not available and moves on, rather than learning a person is in the loop and spending the turn
 * trying to persuade them. Which human decision produced it belongs in the transcript, where a
 * reader can see it, and not in the model's context.
 */
function refusal(tool: string): string {
  return `${tool} is not enabled for this session. Continue without it.`;
}

/** What it is told when nobody was ever going to answer. Shaped after `denial` in ./enquiries.ts. */
function abandonment(tool: string, why: string): string {
  return `${tool} was not authorised: ${why}. Continue without it.`;
}
