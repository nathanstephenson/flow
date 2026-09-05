import type { Entry } from "../../../src/client/reduce.ts";

/**
 * Which rows belong to a Delegation, and which of them to draw.
 *
 * Grouping is a rendering concern (ADR 0015): the Presentation Transcript stays one flat,
 * append-only list ordered by `seq`, and a Delegation's work is recognised here by the `producer`
 * its events already carry. Collapsing therefore filters **keys**, never `entries` — filtering the
 * entry list would break the length heuristic in `agent-session-view.ts`, quietly.
 *
 * DOM-free deliberately, the way `search.ts` is: the TUI can adopt the same grouping rule later
 * rather than growing a second one that disagrees about what belongs to what.
 */

/** The key of the Entry a Delegation's own row uses, given the id its members are attributed to. */
export function delegationKey(delegationId: string): string {
  return `delegation:${delegationId}`;
}

/** The Delegation a row belongs to, or undefined for the Agent Session's own work. */
export function producerKey(entry: Entry): string | undefined {
  return "producer" in entry && entry.producer ? delegationKey(entry.producer.delegationId) : undefined;
}

/**
 * Rows to draw, with the members of every collapsed Delegation removed.
 *
 * A Delegation's own row always survives — collapsing hides what a subagent did, not that it ran,
 * and a collapse that could hide its own control would be a row nobody can get back.
 *
 * Order is preserved exactly. Members are dropped, never moved: a subagent's rows sit where they
 * arrived, which is what keeps this a filter over an append-only list rather than a sort.
 */
export function visibleKeys(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
  collapsed: ReadonlySet<string>,
): string[] {
  if (collapsed.size === 0) return [...keys];
  return keys.filter((key) => {
    const entry = getEntry(key);
    if (!entry) return true;
    const owner = producerKey(entry);
    return owner === undefined || !collapsed.has(owner);
  });
}

/**
 * How many rows a Delegation is holding, so its own row can say what collapsing would hide.
 *
 * Counted over the unfiltered key list, because the count has to stay the same once the rows it
 * counts have been filtered away — otherwise a collapsed Delegation reports zero.
 */
export function memberCount(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
  delegation: string,
): number {
  let count = 0;
  for (const key of keys) {
    const entry = getEntry(key);
    if (entry && producerKey(entry) === delegation) count += 1;
  }
  return count;
}

/** Every Delegation with at least one row of its own, in the order they first appear. */
export function delegationsWithMembers(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of keys) {
    const entry = getEntry(key);
    if (!entry) continue;
    const owner = producerKey(entry);
    if (owner === undefined || seen.has(owner)) continue;
    seen.add(owner);
    ordered.push(owner);
  }
  return ordered;
}
