import type { Skill } from "../../../src/protocol/events.ts";

/**
 * What `/` offers, and what the composer does with what it finds.
 *
 * Pure and DOM-free, so the rules below are unit-tested rather than verified by typing into a box —
 * which is the only way anything in this front end gets verified today (see TODO.md).
 *
 * **A Command and a Skill are different things and the composer treats them differently.** A Command
 * is GoodHarness's own and is dispatched as a Command; a Skill is text the backend expands, and is
 * sent as the message it already is. That difference is what the two pill colours mean.
 */
export type Triggerable =
  | { kind: "command"; name: string; description: string; argumentHint?: string }
  | { kind: "skill"; name: string; description: string; argumentHint?: string };

/**
 * The Commands this Agent Session can be offered, given what its backend declares.
 *
 * One today. It is derived rather than fetched because a Command is GoodHarness's own — the host is
 * what performs it, and nothing about it is a fact the backend could report beyond whether it can
 * serve one at all.
 */
export function commandsFor(compaction: boolean | undefined): Triggerable[] {
  if (!compaction) return [];
  return [
    {
      kind: "command",
      name: "compact",
      description: "Summarise the Conversation Context to free up room",
      argumentHint: "[what to keep]",
    },
  ];
}

export function triggerables(compaction: boolean | undefined, skills: Skill[]): Triggerable[] {
  return [
    ...commandsFor(compaction),
    ...skills.map((skill): Triggerable => ({ kind: "skill", ...skill })),
  ];
}

/**
 * The `/name` a message begins with, if it begins with one.
 *
 * **Position 0 only, and that is not a simplification.** A backend expands a Skill only when its
 * name is the first thing in the message, so a `/` anywhere else is not a trigger and must not be
 * treated as one. It is also what makes `/etc/hosts` and `and/or` ordinary text without anything
 * having to special-case them: the menu never opens, because the slash is not where a trigger lives.
 *
 * Returns the name without its slash, and how far the token runs.
 */
export function leadingToken(text: string): { name: string; to: number } | undefined {
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z0-9][\w-]*)?/.exec(text);
  const name = match?.[1] ?? "";
  return { name, to: name.length + 1 };
}

/**
 * What the leading token names, or nothing.
 *
 * The token has to *end* — at the end of the message or at a space — before it names anything.
 * Without that, `/tddx` would resolve to `tdd` while someone was still typing a longer name, and the
 * pill would appear under a word that does not exist yet.
 */
export function triggeredBy(text: string, catalogue: Triggerable[]): Triggerable | undefined {
  const token = leadingToken(text);
  if (!token || token.name === "") return undefined;
  const next = text[token.to];
  if (next !== undefined && next !== " " && next !== "\n") return undefined;
  return catalogue.find((candidate) => candidate.name === token.name);
}

/**
 * Whether the menu should be open, and on what.
 *
 * Open while the caret is inside the leading token — so it appears on `/`, filters as the name is
 * typed, and goes as soon as the caret leaves for the arguments. A menu that stayed open over the
 * argument text would be offering to replace a name the human has finished with.
 */
export function menuQuery(text: string, caret: number): string | undefined {
  const token = leadingToken(text);
  if (!token || caret > token.to) return undefined;
  return token.name;
}

/**
 * The catalogue narrowed to a query, best first.
 *
 * Prefix matches lead, because someone typing `/co` means a name starting with those letters far
 * more often than one containing them. Beyond that the order is the catalogue's own — Commands
 * before Skills — rather than alphabetical, so the one thing GoodHarness performs itself does not
 * sink into a list of twenty Skills.
 */
export function matching(catalogue: Triggerable[], query: string): Triggerable[] {
  if (query === "") return catalogue;
  const wanted = query.toLowerCase();
  const prefix: Triggerable[] = [];
  const rest: Triggerable[] = [];
  for (const candidate of catalogue) {
    const name = candidate.name.toLowerCase();
    if (name.startsWith(wanted)) prefix.push(candidate);
    else if (name.includes(wanted)) rest.push(candidate);
  }
  return [...prefix, ...rest];
}

/**
 * The message with its leading token replaced by `name`, and where the caret should end up.
 *
 * A trailing space, so the next keystroke is an argument rather than more of the name — and so the
 * token has ended, which is what makes it resolve and show its pill.
 */
export function completed(text: string, name: string): { text: string; caret: number } {
  const token = leadingToken(text);
  const rest = token ? text.slice(token.to) : text;
  const head = `/${name} `;
  return { text: head + rest.replace(/^ /, ""), caret: head.length };
}
