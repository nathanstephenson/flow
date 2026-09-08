import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry, SubagentStatus } from "../../../src/client/reduce.ts";
import { entryKey } from "./entry-key.ts";
import { activeKeys, ordered, subagentKeys } from "./subagent-list.ts";

const subagent = (id: string, status: SubagentStatus): Entry => ({
  kind: "subagent",
  id,
  name: "Explore",
  status,
});

/** A transcript is a list of entries; its keys are what the store hands a component. */
function transcript(...entries: Entry[]) {
  const keys = entries.map(entryKey);
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  return { keys, getEntry: (key: string) => byKey.get(key) };
}

describe("finding the Subagents in a transcript", () => {
  it("picks out the Subagents and leaves everything else", () => {
    const { keys, getEntry } = transcript(
      { kind: "assistant", id: "m1", text: "dispatching", final: true },
      subagent("a", "running"),
      { kind: "tool", id: "t1", name: "Read", input: {}, status: "complete" },
      subagent("b", "complete"),
    );
    assert.deepEqual(subagentKeys(keys, getEntry), ["subagent:a", "subagent:b"]);
  });

  it("returns them in the order they were spawned", () => {
    const { keys, getEntry } = transcript(subagent("first", "complete"), subagent("second", "running"));
    assert.deepEqual(subagentKeys(keys, getEntry), ["subagent:first", "subagent:second"]);
  });

  it("finds none in a transcript that has none", () => {
    const { keys, getEntry } = transcript({ kind: "assistant", id: "m1", text: "hello", final: true });
    assert.deepEqual(subagentKeys(keys, getEntry), []);
  });

  it("is not fooled by another kind whose id begins with the prefix", () => {
    // The prefix match is an optimisation; the kind is the decision.
    const { keys, getEntry } = transcript({ kind: "assistant", id: "subagent:not-really", text: "x", final: true });
    assert.deepEqual(subagentKeys(keys, getEntry), []);
  });
});

describe("ordering the Subagents for reading", () => {
  it("puts running above waiting above finished", () => {
    const { keys, getEntry } = transcript(
      subagent("done", "complete"),
      subagent("blocked", "waiting"),
      subagent("working", "running"),
    );
    assert.deepEqual(ordered(subagentKeys(keys, getEntry), getEntry), [
      "subagent:working",
      "subagent:blocked",
      "subagent:done",
    ]);
  });

  it("puts the oldest at the bottom within a rank", () => {
    const { keys, getEntry } = transcript(
      subagent("oldest", "running"),
      subagent("middle", "running"),
      subagent("newest", "running"),
    );
    assert.deepEqual(ordered(subagentKeys(keys, getEntry), getEntry), [
      "subagent:newest",
      "subagent:middle",
      "subagent:oldest",
    ]);
  });

  it("treats the three terminal states as one rank, ordered by age", () => {
    const { keys, getEntry } = transcript(
      subagent("first", "error"),
      subagent("second", "complete"),
      subagent("third", "aborted"),
    );
    assert.deepEqual(ordered(subagentKeys(keys, getEntry), getEntry), [
      "subagent:third",
      "subagent:second",
      "subagent:first",
    ]);
  });

  /**
   * The regression that matters. A status change does not alter `keys.length`, so a caller caching
   * the whole list against the key array would show this order frozen at its first value — while
   * still looking live, because newly spawned Subagents keep arriving.
   */
  it("reorders when a status changes, with the key list untouched", () => {
    const before = transcript(subagent("a", "running"), subagent("b", "complete"));
    assert.deepEqual(ordered(subagentKeys(before.keys, before.getEntry), before.getEntry), [
      "subagent:a",
      "subagent:b",
    ]);

    // Same keys, same length, same order — only the statuses have swapped.
    const after = transcript(subagent("a", "complete"), subagent("b", "running"));
    assert.deepEqual(after.keys, before.keys, "the key list must be identical for this to prove anything");
    assert.deepEqual(ordered(subagentKeys(after.keys, after.getEntry), after.getEntry), [
      "subagent:b",
      "subagent:a",
    ]);
  });

  it("ranks a key whose Entry has gone last rather than dropping it", () => {
    const { keys } = transcript(subagent("a", "running"), subagent("gone", "running"));
    const getEntry = (key: string) => (key === "subagent:gone" ? undefined : subagent("a", "running"));
    const result = ordered(keys, getEntry);
    assert.equal(result.length, 2, "a Subagent must not vanish from the list without saying so");
    assert.equal(result.at(-1), "subagent:gone");
  });

  it("leaves the caller's array alone", () => {
    const { keys, getEntry } = transcript(subagent("a", "complete"), subagent("b", "running"));
    const spawned = subagentKeys(keys, getEntry);
    const copy = [...spawned];
    ordered(spawned, getEntry);
    assert.deepEqual(spawned, copy, "sorting in place would reorder a cached membership list");
  });
});

describe("which Subagents are still working", () => {
  it("counts running and waiting, and nothing finished", () => {
    const { keys, getEntry } = transcript(
      subagent("working", "running"),
      subagent("blocked", "waiting"),
      subagent("done", "complete"),
      subagent("failed", "error"),
      subagent("stopped", "aborted"),
    );
    assert.deepEqual(activeKeys(subagentKeys(keys, getEntry), getEntry), [
      "subagent:working",
      "subagent:blocked",
    ]);
  });

  it("is empty once everything has finished", () => {
    const { keys, getEntry } = transcript(subagent("a", "complete"), subagent("b", "aborted"));
    assert.deepEqual(activeKeys(subagentKeys(keys, getEntry), getEntry), []);
  });
});
