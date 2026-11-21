import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry, SubagentStatus } from "../../../src/client/reduce.ts";
import { entryKey } from "./entry-key.ts";
import { activeKeys, ordered, runningCalls, subagentKeys, subtitle, timing } from "./subagent-list.ts";

const subagent = (id: string, status: SubagentStatus, parent?: string): Entry => ({
  kind: "subagent",
  id,
  name: "Explore",
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  ...(parent === undefined ? {} : { producer: { subagentId: parent } }),
});

/** `ordered` without the depths, for the cases about order alone. */
const keysOf = (rows: { key: string }[]) => rows.map((row) => row.key);

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
    assert.deepEqual(keysOf(ordered(subagentKeys(keys, getEntry), getEntry)), [
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
    assert.deepEqual(keysOf(ordered(subagentKeys(keys, getEntry), getEntry)), [
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
    assert.deepEqual(keysOf(ordered(subagentKeys(keys, getEntry), getEntry)), [
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
    assert.deepEqual(keysOf(ordered(subagentKeys(before.keys, before.getEntry), before.getEntry)), [
      "subagent:a",
      "subagent:b",
    ]);

    // Same keys, same length, same order — only the statuses have swapped.
    const after = transcript(subagent("a", "complete"), subagent("b", "running"));
    assert.deepEqual(after.keys, before.keys, "the key list must be identical for this to prove anything");
    assert.deepEqual(keysOf(ordered(subagentKeys(after.keys, after.getEntry), after.getEntry)), [
      "subagent:b",
      "subagent:a",
    ]);
  });

  it("ranks a key whose Entry has gone last rather than dropping it", () => {
    const { keys } = transcript(subagent("a", "running"), subagent("gone", "running"));
    const getEntry = (key: string) => (key === "subagent:gone" ? undefined : subagent("a", "running"));
    const result = keysOf(ordered(keys, getEntry));
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

describe("ordering nested Subagents as a tree", () => {
  it("puts each child directly under its parent, one level deeper", () => {
    const { keys, getEntry } = transcript(
      subagent("a", "running"),
      subagent("b", "running"),
      subagent("a1", "complete", "a"),
      subagent("a2", "running", "a"),
      subagent("a2x", "running", "a2"),
    );
    assert.deepEqual(ordered(subagentKeys(keys, getEntry), getEntry), [
      { key: "subagent:b", depth: 0 },
      { key: "subagent:a", depth: 0 },
      { key: "subagent:a2", depth: 1 },
      { key: "subagent:a2x", depth: 2 },
      { key: "subagent:a1", depth: 1 },
    ]);
  });

  it("puts a Subagent whose parent is missing at the root", () => {
    const { keys, getEntry } = transcript(subagent("orphan", "running", "gone"));
    assert.deepEqual(ordered(subagentKeys(keys, getEntry), getEntry), [{ key: "subagent:orphan", depth: 0 }]);
  });
});

describe("a Subagent's own running Background Calls", () => {
  it("counts running calls it started, and nobody else's", () => {
    const call = (id: string, status: "running" | "complete", parent?: string): Entry => ({
      kind: "background_call",
      id,
      tool: "Bash",
      status,
      startedAt: "t",
      ...(parent === undefined ? {} : { producer: { subagentId: parent } }),
    });
    const { keys, getEntry } = transcript(
      subagent("a", "running"),
      subagent("a1", "running", "a"),
      call("c1", "running", "a"),
      call("c2", "running", "a"),
      call("c3", "complete", "a"),
      call("c4", "running", "a1"),
      call("c5", "running"),
    );
    assert.equal(runningCalls(keys, getEntry, "subagent:a"), 2);
    assert.equal(runningCalls(keys, getEntry, "subagent:a1"), 1);
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

/**
 * How long a Subagent has been going, or how long ago it stopped.
 *
 * The one Entry that carries time, because a Subagent is the one thing in the transcript a reader
 * watches rather than reads.
 */
describe("when a Subagent started or stopped", () => {
  const NOW = Date.parse("2026-01-01T01:00:00.000Z");
  const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

  const timed = (status: SubagentStatus, startedAt: string, endedAt?: string): Entry => ({
    kind: "subagent",
    id: "a",
    name: "Explore",
    status,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  });

  const of = (entry: Entry) =>
    entry.kind === "subagent" ? timing(entry, NOW) : { label: "", at: "" };

  it("says when a running Subagent started", () => {
    assert.deepEqual(of(timed("running", at(3))), { label: "started", at: "3m" });
  });

  it("says when a waiting Subagent started, not that it is waiting", () => {
    // The status column already says it is waiting and on what; this answers "for how long".
    assert.deepEqual(of(timed("waiting", at(20))), { label: "started", at: "20m" });
  });

  it("says when a finished Subagent finished, not when it began", () => {
    assert.deepEqual(of(timed("complete", at(30), at(2))), { label: "completed", at: "2m" });
  });

  it("names the outcome rather than calling everything completed", () => {
    // A list where an aborted and a failed Subagent both read "completed" hides the two outcomes
    // actually worth noticing.
    assert.equal(of(timed("aborted", at(30), at(1))).label, "aborted");
    assert.equal(of(timed("error", at(30), at(1))).label, "failed");
  });

  it("falls back to the start when a terminal snapshot carried no end", () => {
    // An old transcript, or a torn Subagent closed on load: better the start than nothing.
    assert.deepEqual(of(timed("complete", at(5))), { label: "completed", at: "5m" });
  });

  it("says just now under a minute, matching the rest of the app", () => {
    assert.equal(of(timed("running", at(0))).at, "just now");
  });

  it("says nothing rather than something wrong for an unparseable time", () => {
    assert.equal(of(timed("running", "")).at, "");
  });
});

describe("what a Subagent row says under its title", () => {
  const models = [{ id: "haiku", provider: "anthropic", label: "Haiku" }];
  const entry = (fields: Partial<Extract<Entry, { kind: "subagent" }>>): Extract<Entry, { kind: "subagent" }> =>
    ({ kind: "subagent", id: "a", name: "Explore", status: "running", startedAt: "", ...fields });

  it("names the type, the model by its label, and the effort", () => {
    assert.equal(subtitle(entry({ description: "read", model: "haiku", effort: "low" }), models), "Explore · Haiku · low");
  });

  it("prints the raw id of a model the list cannot describe", () => {
    assert.equal(subtitle(entry({ description: "read", model: "claude-opus-9" }), models), "Explore · claude-opus-9");
  });

  it("leaves out the type when it is already the title", () => {
    assert.equal(subtitle(entry({ model: "haiku", effort: "low" }), models), "Haiku · low");
    assert.equal(subtitle(entry({}), models), undefined);
  });
});
