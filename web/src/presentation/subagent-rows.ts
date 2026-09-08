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

/** The key of the Entry a Subagent's own row uses, given the id its rows are attributed to. */
export function subagentKey(subagentId: string): string {
  return `subagent:${subagentId}`;
}

/** The Subagent a row belongs to, or undefined for the Agent Session's own work. */
export function producerKey(entry: Entry): string | undefined {
  return "producer" in entry && entry.producer ? subagentKey(entry.producer.subagentId) : undefined;
}

/**
 * The rows the Agent Session produced itself.
 *
 * A Subagent's own `subagent` Entry survives this — it carries no producer, because it is the record
 * that one was started, which is exactly what the main transcript should say.
 */
export function ownKeys(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
): string[] {
  return keys.filter((key) => {
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
