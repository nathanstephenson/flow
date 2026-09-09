/**
 * Where a run of adjacent tool calls sits in a Presentation Transcript.
 *
 * A **Tool Chain** is three or more Entries with nothing but tool calls and thinking in them. It is
 * adjacency and nothing more — the transcript records no causal link between two calls, and a
 * model's parallel tool block lands here the same way a sequential burst does. What it buys is a
 * document that stops
 * growing while a turn greps twenty files: the run collapses to one line, and the prose after it
 * stays on screen.
 *
 * Keys alone answer this, the way `ownKeys` answers its own question: a tool Entry's key is
 * `tool:<id>` (`entryKey`), so no Entry is read and nothing here touches the DOM. Kept in
 * `src/client/` beside `diff.ts` and `tool-summary.ts` rather than in the web client's presentation
 * folder, because the TUI draws this same transcript and should not have to re-derive the rule.
 *
 * The caller passes the keys a reader can actually see — after `ownKeys`, after any search filter,
 * after the tail window — because a grouping can only honestly describe the list it was given.
 */

export type Segment = { kind: "entry"; key: string } | { kind: "chain"; keys: string[] };

const TOOL_PREFIX = "tool:";
const THINKING_PREFIX = "thinking:";

/** Below this many adjacent tool calls a run is just some rows, and hiding them helps nobody. */
const MIN_CHAIN = 3;

export const isToolKey = (key: string): boolean => key.startsWith(TOOL_PREFIX);

/**
 * Thinking rides along. A model reasoning between two calls is one turn working, not the reader
 * getting their prose back, so breaking the run there would leave the flood the chain exists to
 * fold — three greps with a thought between each is exactly the shape that stayed expanded before.
 * A run of thinking alone is not a chain, though: there is no tool in it to name.
 */
const isChainable = (key: string): boolean => isToolKey(key) || key.startsWith(THINKING_PREFIX);

export function toolChains(keys: readonly string[], min: number = MIN_CHAIN): Segment[] {
  const segments: Segment[] = [];
  let run: string[] = [];

  const flush = (): void => {
    if (run.length >= min && run.some(isToolKey)) segments.push({ kind: "chain", keys: run });
    else for (const key of run) segments.push({ kind: "entry", key });
    run = [];
  };

  for (const key of keys) {
    if (isChainable(key)) {
      run.push(key);
      continue;
    }
    flush();
    segments.push({ kind: "entry", key });
  }
  flush();

  return segments;
}
