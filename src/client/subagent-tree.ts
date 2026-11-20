import type { Entry } from "./reduce.ts";

/**
 * Which Subagent spawned which, read from `producer` on each Subagent Entry.
 *
 * The transcript stays flat (ADR 0015), so the tree exists only here, built over keys at paint time.
 * DOM-free so the web client and the TUI share one rule.
 */

const SUBAGENT_PREFIX = "subagent:";

/** The key of the Entry a Subagent's own row uses, given the id its rows are attributed to. */
export function subagentKey(subagentId: string): string {
  return `${SUBAGENT_PREFIX}${subagentId}`;
}

/** The Subagent a row belongs to, or undefined for the Agent Session's own work. */
export function producerKey(entry: Entry): string | undefined {
  return "producer" in entry && entry.producer ? subagentKey(entry.producer.subagentId) : undefined;
}

/**
 * Every Subagent key mapped to its parent's key, undefined at the root.
 *
 * A parent missing from the transcript maps to the root, so a row is never lost.
 */
export function subagentParents(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): Map<string, string | undefined> {
  const subagents = keys.filter((key) => key.startsWith(SUBAGENT_PREFIX) && getEntry(key)?.kind === "subagent");
  const known = new Set(subagents);
  return new Map(subagents.map((key) => {
    const parent = producerKey(getEntry(key)!);
    return [key, parent !== undefined && known.has(parent) ? parent : undefined];
  }));
}

/** How many Subagents are in the chain from `key` up to the root, `key` included. 0 for the Agent Session. */
export function depthOf(parents: ReadonlyMap<string, string | undefined>, key: string | undefined): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let at = key; at !== undefined && !seen.has(at); at = parents.get(at)) {
    seen.add(at);
    if (parents.has(at)) depth++;
  }
  return depth;
}

/** Whether `key` is `ancestor` or sits anywhere below it. */
export function isWithin(parents: ReadonlyMap<string, string | undefined>, key: string | undefined, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at = key; at !== undefined && !seen.has(at); at = parents.get(at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}
