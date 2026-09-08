import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../src/client/reduce.ts";
import { createHaystackCache, entryHaystack, entryMatches, highlightSegments } from "../src/client/search.ts";

const edit: Entry = {
  kind: "tool",
  id: "t1",
  name: "Edit",
  input: { file_path: "/repo/src/client/reduce.ts", old_string: "before", new_string: "after" },
  result: "applied",
  status: "complete",
};

describe("searching a Presentation Transcript", () => {
  it("searches a tool call's input, not only its name and result", () => {
    // The limitation this fixes: the path was on screen in the rendered diff and searching for it
    // found nothing, because the old haystack was name + result.
    assert.equal(entryMatches(edit, "reduce.ts"), true);
    assert.equal(entryMatches(edit, "old_string"), true);
    assert.equal(entryMatches(edit, "applied"), true);
    assert.equal(entryMatches(edit, "edit"), true);
    assert.equal(entryMatches(edit, "connection.ts"), false);
  });

  it("keeps the edited path readable even where JSON has escaped the input", () => {
    assert.equal(entryHaystack(edit).includes("/repo/src/client/reduce.ts"), true);
  });

  it("searches the text of everything else", () => {
    const assistant: Entry = { kind: "assistant", id: "a1", text: "Reading the reducer", final: false };
    const marker: Entry = { kind: "marker", id: "revived-412", marker: "revived", text: "Revived from seq 412" };

    assert.equal(entryMatches(assistant, "reducer"), true);
    assert.equal(entryMatches(marker, "revived from seq"), true);
    assert.equal(entryMatches(marker, "settled"), false);
  });

  it("matches case-insensitively, on a query the caller lowercased once", () => {
    const assistant: Entry = { kind: "assistant", id: "a1", text: "Loading CONTEXT.md", final: true };
    assert.equal(entryMatches(assistant, "context.md"), true);
  });

  it("matches everything when nothing has been typed", () => {
    assert.equal(entryMatches(edit, ""), true);
  });

  it("survives a tool payload JSON cannot hold", () => {
    const circular: Record<string, unknown> = { name: "self" };
    circular["self"] = circular;
    const entry: Entry = { kind: "tool", id: "t2", name: "Weird", input: circular, status: "running" };

    assert.equal(entryMatches(entry, "weird"), true);
    assert.equal(entryMatches(entry, "self"), false, "an unstringifiable input contributes nothing");
  });
});

describe("the haystack cache", () => {
  it("answers the same Entry twice without rebuilding it", () => {
    const cache = createHaystackCache();
    assert.equal(cache.matches(edit, "reduce.ts"), true);
    assert.equal(cache.matches(edit, "reduce.ts"), true);
    assert.equal(cache.matches(edit, "nothing here"), false);
  });

  it("sees a growing snapshot the moment it starts matching", () => {
    // upsert produces a NEW Entry on every change, so the cache is keyed on an object that no
    // longer exists and there is nothing to invalidate. A useMemo over the key list would still be
    // showing the state before the word arrived.
    const cache = createHaystackCache();
    const partial: Entry = { kind: "assistant", id: "a1", text: "I will read redu", final: false };
    const grown: Entry = { kind: "assistant", id: "a1", text: "I will read reduce.ts now", final: false };

    assert.equal(cache.matches(partial, "reduce.ts"), false);
    assert.equal(cache.matches(grown, "reduce.ts"), true);
  });
});

describe("highlighting the matched runs", () => {
  it("splits around a match", () => {
    assert.deepEqual(highlightSegments("the reducer runs", "reducer"), [
      { text: "the ", match: false },
      { text: "reducer", match: true },
      { text: " runs", match: false },
    ]);
  });

  it("preserves the original case in the segment it matched", () => {
    assert.deepEqual(highlightSegments("Reduce", "reduce"), [{ text: "Reduce", match: true }]);
  });

  it("marks a match at the start and at the end", () => {
    assert.deepEqual(highlightSegments("abc", "a"), [
      { text: "a", match: true },
      { text: "bc", match: false },
    ]);
    assert.deepEqual(highlightSegments("abc", "c"), [
      { text: "ab", match: false },
      { text: "c", match: true },
    ]);
  });

  it("merges adjacent matches into one highlight", () => {
    assert.deepEqual(highlightSegments("aaa", "a"), [{ text: "aaa", match: true }]);
    assert.deepEqual(highlightSegments("xaay", "a"), [
      { text: "x", match: false },
      { text: "aa", match: true },
      { text: "y", match: false },
    ]);
  });

  it("finds every occurrence", () => {
    assert.deepEqual(highlightSegments("a-a-a", "a"), [
      { text: "a", match: true },
      { text: "-", match: false },
      { text: "a", match: true },
      { text: "-", match: false },
      { text: "a", match: true },
    ]);
  });

  it("returns the text whole when there is no query and no match", () => {
    assert.deepEqual(highlightSegments("untouched", ""), [{ text: "untouched", match: false }]);
    assert.deepEqual(highlightSegments("untouched", "missing"), [{ text: "untouched", match: false }]);
  });

  it("returns nothing for empty text", () => {
    assert.deepEqual(highlightSegments("", "a"), []);
    assert.deepEqual(highlightSegments("", ""), []);
  });

  it("keeps the text intact where lowercasing would misalign the offsets", () => {
    // "İ".toLowerCase() is two code units, so an index into the lowered copy addresses a different
    // character in the original. Losing the highlight beats slicing the text apart at the wrong
    // place.
    const text = "İstanbul";
    assert.deepEqual(highlightSegments(text, "stanbul"), [{ text, match: false }]);
  });
});

/**
 * A Subagent has no `text`, so the haystack's early return had to learn about it. This one fails
 * silently rather than loudly if it regresses: searching for a subagent by name would simply stop
 * matching, with nothing to say it had.
 */
describe("searching for a Subagent", () => {
  it("matches on the subagent's name", () => {
    const entry: Entry = { kind: "subagent", id: "call_1", name: "explorer", status: "running" };
    assert.equal(entryHaystack(entry).includes("explorer"), true);
  });

  it("matches on the brief it was given", () => {
    const entry: Entry = {
      kind: "subagent",
      id: "call_1",
      name: "explorer",
      description: "read package.json",
      status: "complete",
    };
    assert.equal(entryHaystack(entry).includes("package.json"), true);
  });

  it("does not throw on a Subagent with no brief", () => {
    const entry: Entry = { kind: "subagent", id: "call_1", name: "explorer", status: "complete" };
    assert.equal(entryHaystack(entry), "explorer");
  });
});
