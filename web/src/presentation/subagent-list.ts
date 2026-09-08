import type { Entry, SubagentStatus } from "../../../src/client/reduce.ts";

/**
 * The Subagents of one Agent Session, as a list a reader can scan.
 *
 * Two functions rather than one, because the two halves of "which Subagents, in what order" go
 * stale on different signals — and conflating them costs either correctness or a scan of the whole
 * transcript on every frame:
 *
 * - **Which** changes only when a Subagent is spawned, and spawning appends an Entry, so
 *   `keys.length` changes. A caller can cache `subagentKeys` against exactly that.
 * - **What order** depends on `status`, which moves without `keys.length` moving at all — a
 *   Subagent's Entry is upserted in place and never shifts. So `ordered` must be re-derived per
 *   frame, and it is cheap because it walks the Subagents rather than the transcript.
 *
 * Get that split wrong in the obvious direction — memoise the whole thing on the key array — and
 * every status freezes at whatever it was when the Subagent first appeared. The list keeps looking
 * live because new Subagents still arrive.
 *
 * DOM-free like `subagent-tree.ts`, so the TUI can show the same list in the same order later
 * rather than inventing a second rule.
 */

/** A Subagent Entry's key is its kind and id, which is what `entryKey` builds for it. */
const SUBAGENT_PREFIX = "subagent:";

/**
 * Running first, then waiting, then anything finished.
 *
 * The three terminal states share a rank: they are all "not working any more", and a reader
 * scanning for what is happening now does not need `complete` above `aborted`. Their relative order
 * therefore falls to first-seen, like everything else in a group.
 */
const RANK: Record<SubagentStatus, number> = {
  running: 0,
  waiting: 1,
  complete: 2,
  aborted: 2,
  error: 2,
};

/** Every Subagent in the transcript, in the order they were spawned. `O(keys)`. */
export function subagentKeys(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): string[] {
  return keys.filter((key) => key.startsWith(SUBAGENT_PREFIX) && getEntry(key)?.kind === "subagent");
}

/**
 * The same Subagents, ordered for reading: still working at the top, oldest at the bottom.
 *
 * `spawned` is expected in first-seen order — what `subagentKeys` returns — so "oldest last" is its
 * reverse. Within a rank the newest sits above the older ones, which puts the Subagent a reader is
 * most likely to care about nearest the top of its group.
 *
 * `O(subagents)`, deliberately: this runs on every coalesced frame while a subagent streams.
 */
export function ordered(
  spawned: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): string[] {
  return spawned
    .map((key, index) => ({ key, index, status: statusOf(key, getEntry) }))
    .sort((left, right) => RANK[left.status] - RANK[right.status] || right.index - left.index)
    .map((row) => row.key);
}

/** Subagents still working, for anything that wants the count without the list. */
export function activeKeys(
  spawned: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): string[] {
  return spawned.filter((key) => RANK[statusOf(key, getEntry)] < RANK.complete);
}

/**
 * A key whose Entry has gone is treated as finished rather than dropped.
 *
 * It cannot happen while the transcript is append-only, but sorting is the wrong place to discover
 * that it has: silently dropping the row would lose a Subagent from the list with nothing to say
 * so, while ranking it last leaves it visible and out of the way.
 */
function statusOf(key: string, getEntry: (key: string) => Entry | undefined): SubagentStatus {
  const entry = getEntry(key);
  return entry?.kind === "subagent" ? entry.status : "complete";
}
