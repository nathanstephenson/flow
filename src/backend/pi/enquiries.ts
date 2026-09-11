import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BackendEvent, Question } from "../../protocol/events.ts";

export const ASK_TOOL = "ask_question";

const parameters = Type.Object({
  questions: Type.Array(Type.Object({
    header: Type.String({ minLength: 1 }),
    question: Type.String({ minLength: 1 }),
    multiSelect: Type.Boolean(),
    options: Type.Array(Type.Object({
      label: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      preview: Type.Optional(Type.String()),
    }), { minItems: 2, maxItems: 4 }),
  }), { minItems: 1, maxItems: 4 }),
});

type Pending = { questions: Question[]; resolve: (answers: string[][] | undefined) => void };

export class PiEnquiries {
  private readonly open = new Map<string, Pending>();
  private readonly emit: (event: BackendEvent) => void;

  constructor(emit: (event: BackendEvent) => void) {
    this.emit = emit;
  }

  readonly tool = defineTool({
    name: ASK_TOOL,
    label: "Ask a question",
    description: "Ask the human one to four questions and wait for their answers. They can select options or write their own answer. Do not add an Other option.",
    promptSnippet: "Ask the human for a decision or missing information",
    parameters,
    execute: async (askId, { questions }, signal) => {
      const answers = signal?.aborted ? undefined : await new Promise<string[][] | undefined>((resolve) => {
        const abort = () => this.abandon(askId);
        this.open.set(askId, { questions, resolve: (answers) => {
          signal?.removeEventListener("abort", abort);
          resolve(answers);
        } });
        signal?.addEventListener("abort", abort, { once: true });
        this.emit({ type: "enquiry", askId, questions, state: "asked" });
      });
      return {
        content: [{ type: "text" as const, text: answers
          ? JSON.stringify(questions.map((question, index) => ({ question: question.question, answers: answers[index] })))
          : "The human did not answer because the turn stopped." }],
        details: { answers },
      };
    },
  });

  private abandon(askId: string): void {
    const pending = this.open.get(askId);
    if (!pending) return;
    this.open.delete(askId);
    this.emit({ type: "enquiry", askId, questions: pending.questions, state: "aborted" });
    pending.resolve(undefined);
  }

  answer(askId: string, answers: string[][]): boolean {
    const pending = this.open.get(askId);
    if (!pending || answers.length !== pending.questions.length) return false;
    this.open.delete(askId);
    this.emit({ type: "enquiry", askId, questions: pending.questions, state: "answered", answers });
    pending.resolve(answers);
    return true;
  }
}
