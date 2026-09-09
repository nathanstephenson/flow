import type { Question } from "../protocol/events.ts";

/**
 * What an Enquiry looks like to a reader, and what answering one means.
 *
 * DOM-free and beside `tool-summary.ts` for the same reason: it returns strings and plain records,
 * and both front-ends can print those. What each one *draws* differs — a listbox in the browser, a
 * numbered column in the terminal — but which rows exist, which are chosen, and what a committed
 * answer contains must not, or the two front-ends have two different features with one name.
 */

/**
 * One row of the picker: an Option the model offered, or the human's own answer.
 *
 * `other` is a row like any other rather than a separate control, which is the whole of why the
 * free-text case needs no special handling downstream. It is chosen, moved to and committed exactly
 * as an Option is; the only thing that distinguishes it is where its `label` came from.
 */
export type Row = { label: string; description?: string; other: boolean };

/** Where the human is up to in an Enquiry. Held by each front-end; the shape is shared so the rules are. */
export type Answering = {
  /** Which Question is on screen. Enquiries are paced one at a time in both front-ends. */
  index: number;
  cursor: number;
  /** Labels chosen so far, per Question, index-aligned with the Enquiry's `questions`. */
  chosen: string[][];
};

export function startAnswering(questions: Question[]): Answering {
  return { index: 0, cursor: 0, chosen: questions.map(() => []) };
}

/**
 * The rows for one Question, given whatever is currently typed in the box.
 *
 * The Other row exists only while there is text, and is always last. Appending rather than
 * prepending keeps the digits stable: `1` is the first Option whether or not anyone has started
 * typing, so a number read off the screen a moment ago still means what it meant.
 */
export function rowsFor(question: Question, other: string): Row[] {
  const rows: Row[] = question.options.map((option) => ({
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
    other: false,
  }));
  const typed = other.trim();
  if (typed !== "") rows.push({ label: typed, description: "your own answer", other: true });
  return rows;
}

/** Where the cursor lands after moving by `delta`, wrapping. Guarded against an empty list. */
export function cursorAfter(current: number, delta: number, rows: number): number {
  if (rows <= 0) return 0;
  return (((current + delta) % rows) + rows) % rows;
}

/** Where the cursor lands after moving by `delta`, clamped — the TUI's idiom, as every list there clamps. */
export function cursorClamped(current: number, delta: number, rows: number): number {
  if (rows <= 0) return 0;
  return Math.min(rows - 1, Math.max(0, current + delta));
}

/**
 * Where the cursor goes when the box gains or loses its first character.
 *
 * This exists because of a trap, and the trap is worth stating: type an answer nobody offered, press
 * Enter, and without this the Option the cursor happened to be resting on is what gets sent. The
 * human's own words are discarded in favour of a choice they never made — silently, and into a
 * decision they were asked to make.
 *
 * So the cursor follows the typing onto the Other row, and comes back off it when the text goes
 * away. Once there, an arrow key may move it off again, and it stays where it is put: someone who
 * types a note and *then* picks an Option meant to pick the Option.
 */
export function cursorAfterTyping(
  current: number,
  hadText: boolean,
  hasText: boolean,
  rows: number,
): number {
  if (hasText && !hadText) return Math.max(0, rows - 1);
  // The Other row has just gone; the cursor was on it and now points past the end.
  if (!hasText && hadText) return Math.min(current, Math.max(0, rows - 1));
  return current;
}

/** A label added or removed. Order is preserved so answers read in the order they were picked. */
export function toggled(chosen: readonly string[], label: string): string[] {
  return chosen.includes(label) ? chosen.filter((seen) => seen !== label) : [...chosen, label];
}

/**
 * Whether the current Question can be answered as it stands.
 *
 * False only for an empty multiSelect. A single-select always has the cursor on something, and
 * committing an empty set would send the model an answer that says nothing while looking like
 * consent — so it is refused, and the front-end says what is missing rather than doing nothing.
 */
export function canCommit(question: Question, chosen: readonly string[]): boolean {
  return question.multiSelect ? chosen.length > 0 : true;
}

/**
 * The Answers for an Enquiry, ready for the `answer_enquiry` command.
 *
 * One entry per Question, always — the backend holds a single promise for the whole tool call, and
 * the host refuses an answer of the wrong arity rather than letting a short one through as consent.
 */
export function answersOf(state: Answering, questions: Question[]): string[][] {
  return questions.map((_, index) => [...(state.chosen[index] ?? [])]);
}

/** Whether every Question has been answered and the Enquiry is ready to send. */
export function isFinished(state: Answering, questions: Question[]): boolean {
  return state.index >= questions.length;
}

/**
 * How far through an Enquiry the human is, or undefined for one with a single Question.
 *
 * Undefined rather than `"1 of 1"`, so the caller's decision is *is there a row to show* rather than
 * whether to compare two numbers — the idiom `subagentStripLabel` already uses.
 */
export function progressLabel(state: Answering, questions: Question[]): string | undefined {
  return questions.length > 1 ? `${state.index + 1} of ${questions.length}` : undefined;
}

/**
 * One line per Question: what was asked, and what was chosen.
 *
 * The whole requirement of the transcript row, in one function. A reader scrolling back to an
 * answered Enquiry wants both halves and gets neither from a JSON well — and cannot get them from
 * the tool result either, which the SDK writes as prose.
 *
 * The header rather than the question, because this is a list and four full sentences with their
 * answers appended is not one anybody reads.
 */
export function answerLines(questions: Question[], answers: string[][] | undefined): string[] {
  return questions.map((question, index) => {
    const chosen = answers?.[index] ?? [];
    return `${question.header} — ${chosen.length === 0 ? "no answer" : chosen.join(", ")}`;
  });
}
