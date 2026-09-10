import { editDiff } from "./diff.ts";
import type { Entry } from "./reduce.ts";

/**
 * Finding text in a Presentation Transcript.
 *
 * DOM-free deliberately rather than incidentally: `highlightSegments` returns segments and not
 * nodes, which is what keeps this module compiling under the root config's `lib: ["ES2023"]`, and so
 * what lets the TUI match the way the web UI matches instead of growing a second rule.
 *
 * Case-insensitive substring, and nothing else. No regex (a reader typing `(` into a filter box does
 * not mean a group) and no fuzzy matching (which finds things nobody asked for and hides the reason).
 */

/**
 * Everything about an Entry that a reader could reasonably expect a search to look at.
 *
 * The previous client searched a tool call's name and result but not its **input**, so searching for
 * a path you had just watched being edited did not match the Edit call that edited it — even though
 * the path was on screen in the rendered diff, because it is in `input.file_path`. The arguments are
 * the half of a tool call a reader is most likely to remember, so they are in the haystack.
 *
 * A Subagent has no `text` at all, so the early return had to learn about it: what a reader
 * remembers of one is what it was called and what it was asked to do.
 */
export function entryHaystack(entry: Entry): string {
  if (entry.kind === "subagent") {
    return [entry.name, entry.description].filter((part) => part !== undefined && part !== "").join("\n");
  }
  /*
   * An Enquiry has no `text` either, and what a reader remembers of one is the decision it put to
   * them: the question, the options offered, and — most of all — what they chose. Searching for the
   * answer you gave is the likeliest way anyone comes back to one of these.
   */
  if (entry.kind === "enquiry") {
    return entry.questions
      .flatMap((question, index) => [
        question.header,
        question.question,
        ...question.options.map((option) => option.label),
        ...(entry.answers?.[index] ?? []),
      ])
      .filter((part) => part !== "")
      .join("\n");
  }
  /*
   * A Background Call has no `text` either, and only its tool name to be remembered by. Its
   * arguments are deliberately not repeated here — they are on the `tool` row sharing its id, which
   * this same function already indexes through the stringified input, so the command stays findable
   * without being stored twice.
   */
  if (entry.kind === "background_call") return entry.tool;
  if (entry.kind !== "tool") return entry.text;
  const diff = editDiff(entry.input);
  // The diff's path is already inside the stringified input; it is repeated here so that a query
  // still matches when editDiff has recognised a path this haystack's JSON has escaped.
  return [entry.name, stringify(entry.input), stringify(entry.result), diff?.path]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n");
}

/**
 * Whether an Entry matches. The query arrives already lowercased, so a keystroke lowercases once
 * rather than once per Entry, and an empty query matches everything — a filter nobody has typed into
 * hides nothing.
 */
export function entryMatches(entry: Entry, lowercasedQuery: string): boolean {
  if (lowercasedQuery === "") return true;
  return entryHaystack(entry).toLowerCase().includes(lowercasedQuery);
}

/** Split `text` into runs, marking the ones the query matched. `<mark>` is the component's business. */
export type HighlightSegment = { text: string; match: boolean };

export function highlightSegments(text: string, lowercasedQuery: string): HighlightSegment[] {
  if (text === "") return [];
  if (lowercasedQuery === "") return [{ text, match: false }];

  const lowered = text.toLowerCase();
  // Lowercasing can change a string's length — `İ`.toLowerCase() is two code units — and then an
  // index into the lowered copy no longer addresses the same character in the original. Rather than
  // slice at the wrong offset and mangle the text, drop the highlight and keep the text intact.
  if (lowered.length !== text.length) return [{ text, match: false }];

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (let at = lowered.indexOf(lowercasedQuery); at !== -1; at = lowered.indexOf(lowercasedQuery, cursor)) {
    if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false });
    cursor = at + lowercasedQuery.length;
    const previous = segments[segments.length - 1];
    // Two matches that touch are one highlight to whoever is looking at it, so they are one segment;
    // emitting them separately would put a seam in the middle of a `<mark>` for no reason.
    if (previous?.match) previous.text += text.slice(at, cursor);
    else segments.push({ text: text.slice(at, cursor), match: true });
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/**
 * A per-Entry cache of lowercased haystacks, for a component layer that filters the whole
 * Presentation Transcript on every keystroke and on every streaming tick.
 */
export type HaystackCache = { matches(entry: Entry, lowercasedQuery: string): boolean };

export function createHaystackCache(): HaystackCache {
  // Keyed on the Entry object, which is what makes this cache free of invalidation: `upsert`
  // produces a NEW Entry on every change (reduce.ts:169-172), so an Entry whose snapshot has grown
  // is a different key and the stale value is unreachable by construction. It is also why the cache
  // stays correct mid-stream — a growing snapshot that *newly* matches starts matching on the tick
  // it does, which a useMemo keyed on the key list would miss, because the key list did not change.
  const lowered = new WeakMap<Entry, string>();
  return {
    matches(entry, lowercasedQuery) {
      if (lowercasedQuery === "") return true;
      let haystack = lowered.get(entry);
      if (haystack === undefined) {
        haystack = entryHaystack(entry).toLowerCase();
        lowered.set(entry, haystack);
      }
      return haystack.includes(lowercasedQuery);
    },
  };
}

/**
 * Strings verbatim, everything else as JSON — which is how a tool payload is rendered anyway, so the
 * haystack matches what is on screen. JSON escaping is the one gap: a query containing a backslash
 * or a double quote will not match inside a stringified payload.
 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Circular, or carrying a BigInt. Nothing about a keystroke is worth a throw.
    return "";
  }
}
