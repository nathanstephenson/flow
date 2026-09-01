import type { Entry } from "../../../src/client/reduce.ts";

/**
 * The identity of an Entry within a Presentation Transcript.
 *
 * Both parts are needed: ids are only unique within a kind, so an assistant message and a tool call
 * can share one. Keying on the id alone makes two entries collide and React reuses the wrong node.
 *
 * This is stable across a growing snapshot — `message` and `thinking` events carry the whole
 * accumulated text each time under the same id — which is what lets the transcript replace an entry
 * in place instead of appending, and so what keeps a stream from fighting the reader's scrolling.
 */
export function entryKey(entry: Entry): string {
  return `${entry.kind}:${entry.id}`;
}
