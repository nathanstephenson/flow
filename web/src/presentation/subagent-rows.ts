import type { Entry } from "../../../src/client/reduce.ts";

/**
 * Which rows belong to a Subagent, and which belong to the Agent Session itself.
 *
 * A Subagent's work is attributed rather than nested (ADR 0015): the Presentation Transcript stays
 * one flat, append-only list ordered by `seq`, and a row's `producer` says who made it. That makes
 * splitting the two surfaces a filter over **keys**, never over `entries` — filtering the entry list
 * would break the length heuristic in `agent-session-view.ts`, quietly.
 *
 * The main transcript shows the session's own rows and a card saying a Subagent was started. What
 * the Subagent actually did belongs to the Agents tab: interleaved in the transcript it read as the
 * session's own work, and with two Subagents at once it read as nobody's in particular.
 *
 * DOM-free like `search.ts`, so the TUI can draw the same split rather than inventing a second rule.
 */

const SUBAGENT_PREFIX = "subagent:";
/**
 * An Enquiry shares its id with the `AskUserQuestion` call that asked it, exactly as a Subagent
 * shares its id with the `Agent` call that spawned it — so the transcript holds two Entries for one
 * thing here too, and the same rule applies: the row carrying the status is the one to keep.
 */
const ENQUIRY_PREFIX = "enquiry:";

/** The key of the Entry a Subagent's own row uses, given the id its rows are attributed to. */
export function subagentKey(subagentId: string): string {
  return `${SUBAGENT_PREFIX}${subagentId}`;
}

/** The Subagent a row belongs to, or undefined for the Agent Session's own work. */
export function producerKey(entry: Entry): string | undefined {
  return "producer" in entry && entry.producer ? subagentKey(entry.producer.subagentId) : undefined;
}

/**
 * The rows the Agent Session produced itself, and one row per Subagent it started.
 *
 * Two things are dropped, for the same reason: neither tells a reader anything the Subagent's own
 * card does not.
 *
 * The first is everything a Subagent produced — its work belongs to the Agents tab.
 *
 * The second is the tool call that spawned it. A Subagent shares its id with that call, so the
 * transcript holds two Entries for it (ADR 0015): the `tool` row is what the parent asked for, and
 * the `subagent` row is what came of it. That pairing earned its keep while the card sat above the
 * Subagent's actual rows. With those gone the two rows are adjacent, carry the same brief, and only
 * one of them carries a status — so the tool row is the one to lose.
 *
 * An Enquiry is dropped on the same rule, which is why this generalised rather than growing a second
 * function beside it: its `AskUserQuestion` row and its `enquiry` row are the same two views of one
 * thing, and the `enquiry` row is the one that says what was chosen.
 */
export function ownKeys(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): string[] {
  // Keys alone answer this: a Subagent's Entry key is `subagent:<id>` and its spawning call's is
  // `tool:<id>`, so the pairing is visible without reading a single Entry. An Enquiry's is the same
  // shape under a different prefix.
  const spawners = new Set(
    keys.flatMap((key) => {
      if (key.startsWith(SUBAGENT_PREFIX)) return [`tool:${key.slice(SUBAGENT_PREFIX.length)}`];
      if (key.startsWith(ENQUIRY_PREFIX)) return [`tool:${key.slice(ENQUIRY_PREFIX.length)}`];
      return [];
    }),
  );

  return keys.filter((key) => {
    if (spawners.has(key)) return false;
    const entry = getEntry(key);
    // A key with no Entry cannot happen while the transcript is append-only, but dropping it here
    // would hide a row for a reason nobody could see. Kept, and rendered as whatever it turns out
    // to be.
    return entry === undefined || producerKey(entry) === undefined;
  });
}

/**
 * The rows one Subagent produced, in the order they arrived — the whole of its own transcript: its
 * messages, its thinking and its tool calls, and nothing of its parent's.
 */
export function memberKeys(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
  subagent: string,
): string[] {
  return keys.filter((key) => {
    const entry = getEntry(key);
    return entry !== undefined && producerKey(entry) === subagent;
  });
}
