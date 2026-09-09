import type { Question, QuestionOption } from "../../protocol/events.ts";

/** The tool whose call asks a human something. Named once, because two spellings is one bug. */
export const ASK_TOOL = "AskUserQuestion";

/**
 * How a pending Enquiry is settled: an allowed call carrying the human's answers, or a denial the
 * model can read and carry on from.
 *
 * Deliberately not a promise's `resolve`/`reject` pair. Nothing here ever rejects — see the class
 * below — and typing it as the SDK's own two outcomes is what makes that unmissable.
 */
export type Settle = (
  result:
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string },
) => void;

type Pending = {
  questions: Question[];
  /** The tool call's own input, kept whole so the answers can be handed back inside it. */
  input: Record<string, unknown>;
  settle: Settle;
};

/**
 * The Enquiries open in one turn, and the permission callbacks held for them.
 *
 * The Claude SDK asks whether a tool may run through `canUseTool`, and does not continue until that
 * promise settles. For every other tool the adapter answers immediately; for this one the answer is
 * a human's, which may be minutes away or may never come. So a promise is parked here, and the whole
 * of this module's job is that **every path settles it**.
 *
 * That is the one rule, and it is why nothing here rejects. A rejected callback leaves the CLI with
 * a `tool_use` it never resolved: the turn cannot end, the Session Host never clears `turnInFlight`,
 * and the Agent Session is pinned in `running` with no key that unpins it. A *denial* is a real
 * `tool_result` — `spikes/ask-user-question.ts` confirmed it comes back well-formed, carrying
 * `is_error` against the right id — so the conversation stays complete and a later Revive resumes
 * onto a turn with nothing dangling.
 *
 * Its own module rather than fields on ClaudeSession because that session cannot be constructed
 * without spawning a Claude process, so none of this would be reachable from a test there — the same
 * reason `Subagents` and `StreamedMessage` live apart.
 */
export class PendingEnquiries {
  private readonly open = new Map<string, Pending>();

  /** Park a callback against the call that asked. `askId` is the SDK's `toolUseID`. */
  hold(askId: string, questions: Question[], input: Record<string, unknown>, settle: Settle): void {
    this.open.set(askId, { questions, input, settle });
  }

  /** What an open Enquiry asked, or undefined for one already settled. */
  describe(askId: string): Question[] | undefined {
    return this.open.get(askId)?.questions;
  }

  /**
   * Settle an open Enquiry with a human's answers. False when there was nothing open under this id,
   * which is an ordinary race — a second click, or an answer typed against a transcript older than
   * the Backend Session serving it.
   */
  answer(askId: string, answers: string[][]): boolean {
    const pending = this.open.get(askId);
    if (!pending) return false;
    this.open.delete(askId);
    pending.settle({ behavior: "allow", updatedInput: answersFor(pending.input, answers) });
    return true;
  }

  /**
   * Settle an open Enquiry as unanswered, denying the tool with something the model can act on.
   * Answers with what it was asking, so the caller can emit the terminal snapshot for it.
   */
  abandon(askId: string, why: string): Question[] | undefined {
    const pending = this.open.get(askId);
    if (!pending) return undefined;
    this.open.delete(askId);
    pending.settle({ behavior: "deny", message: denial(why) });
    return pending.questions;
  }

  /** Abandon everything open, and say what was abandoned so each gets its terminal snapshot. */
  abandonAll(why: string): { askId: string; questions: Question[] }[] {
    return [...this.open.keys()].flatMap((askId) => {
      const questions = this.abandon(askId, why);
      return questions ? [{ askId, questions }] : [];
    });
  }

  /**
   * Forget everything without settling anything.
   *
   * Beside `Subagents.clear()` and for the same reason — nothing may reach the turn after this one —
   * but unlike it, this is **not** how a turn ends. Anything still open at that point must be
   * abandoned first, or its callback is dropped and the CLI waits forever. `clear()` is for when the
   * callbacks are already gone: the process behind them is down.
   */
  clear(): void {
    this.open.clear();
  }
}

/**
 * The tool input with the human's answers folded into it, which is what an allowed call hands back.
 *
 * `answers` is keyed by the question's own text, and takes a bare string or an array of them — both
 * confirmed against the CLI in `spikes/ask-user-question.ts`, where an array came back comma-joined
 * in the tool result. A single-select therefore sends a string rather than a one-element array, so
 * what the model reads is what a human would write.
 *
 * The rest of `input` is carried through untouched. The SDK replaces the call's arguments with this,
 * so anything dropped here is dropped from the call.
 */
export function answersFor(
  input: Record<string, unknown>,
  answers: string[][],
): Record<string, unknown> {
  const questions = questionsOf(input);
  const keyed: Record<string, string | string[]> = {};

  questions.forEach((question, index) => {
    const chosen = answers[index] ?? [];
    // Last-wins on two questions with identical text, which is all a text-keyed map can express.
    // The alternative is dropping one, and an answer the human gave is worse to lose than to move.
    keyed[question.question] = question.multiSelect ? chosen : (chosen[0] ?? "");
  });

  return { ...input, answers: keyed };
}

/**
 * The Questions a tool call is posing, read leniently.
 *
 * Lenient on purpose, and in one specific direction: it does not enforce the schema's one-to-four
 * Questions or two-to-four Options. Refusing a shape the CLI itself produced would stall a turn over
 * a disagreement about a document, so this carries whatever arrived and lets a front-end render it.
 *
 * Everything is narrowed rather than trusted — `canUseTool` hands over `Record<string, unknown>`, and
 * there is no `AskUserQuestionInput` type in the SDK to lean on. A Question with no text at all is
 * dropped, because a picker cannot show one and the human would be answering a blank.
 */
export function questionsOf(input: unknown): Question[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): Question[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question : "";
    if (question === "") return [];

    return [
      {
        // The header is a label, and falling back to the question keeps a progress row printable.
        header: typeof record.header === "string" && record.header !== "" ? record.header : question,
        question,
        multiSelect: record.multiSelect === true,
        options: optionsOf(record.options),
      },
    ];
  });
}

function optionsOf(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): QuestionOption[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    // The label is the option's identity — it is what is sent back as the answer — so one without a
    // label is not a choice anybody could make, and is dropped rather than rendered blank.
    if (typeof record.label !== "string" || record.label === "") return [];
    return [
      {
        label: record.label,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(typeof record.preview === "string" ? { preview: record.preview } : {}),
      },
    ];
  });
}

/**
 * What the model is told when nobody answered.
 *
 * Ends the way the adapter's existing refusal does — "Continue without it" — because the model is
 * not being corrected, it is being unblocked, and a turn that stops here has failed for the human
 * twice over.
 */
function denial(why: string): string {
  return `The human did not answer: ${why}. Continue without it.`;
}
