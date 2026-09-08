import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { entryKey } from "./entry-key.ts";
import { memberKeys, ownKeys, producerKey, subagentKey } from "./subagent-rows.ts";

const parentSaid: Entry = { kind: "assistant", id: "m1", text: "dispatching", final: true };
const subagentEntry: Entry = { kind: "subagent", id: "call_1", name: "Explore", status: "running" };
const childSaid: Entry = {
  kind: "assistant",
  id: "m2",
  text: "reading",
  final: true,
  producer: { subagentId: "call_1" },
};
const childTool: Entry = {
  kind: "tool",
  id: "t1",
  name: "Read",
  input: {},
  status: "complete",
  producer: { subagentId: "call_1" },
};
const parentTool: Entry = { kind: "tool", id: "t2", name: "Bash", input: {}, status: "complete" };

const ENTRIES = [parentSaid, subagentEntry, childSaid, childTool, parentTool];
const KEYS = ENTRIES.map(entryKey);
const getEntry = (key: string): Entry | undefined => ENTRIES.find((entry) => entryKey(entry) === key);

describe("splitting a Subagent's rows from the session's own", () => {
  it("recognises a row by the producer it already carries", () => {
    assert.equal(producerKey(childSaid), "subagent:call_1");
    assert.equal(producerKey(parentSaid), undefined, "the session's own work belongs to no Subagent");
  });

  it("keeps the session's own rows and drops what a Subagent produced", () => {
    // The main transcript's whole job now: the session's work, plus the notice that a Subagent ran.
    assert.deepEqual(ownKeys(KEYS, getEntry), [
      entryKey(parentSaid),
      entryKey(subagentEntry),
      entryKey(parentTool),
    ]);
  });

  it("keeps the Subagent's own Entry, which carries no producer", () => {
    // That row *is* the notice that one was started, so it must survive the split that hides its
    // work — otherwise the transcript stops mentioning the Subagent at all.
    assert.ok(ownKeys(KEYS, getEntry).includes(entryKey(subagentEntry)));
  });

  it("gives one Subagent its own rows and nobody else's", () => {
    assert.deepEqual(memberKeys(KEYS, getEntry, subagentKey("call_1")), [
      entryKey(childSaid),
      entryKey(childTool),
    ]);
  });

  it("gives a Subagent that produced nothing an empty transcript", () => {
    assert.deepEqual(memberKeys(KEYS, getEntry, subagentKey("never-ran")), []);
  });

  it("keeps a key whose Entry has gone rather than hiding the row", () => {
    const keys = [...KEYS, "assistant:gone"];
    assert.ok(ownKeys(keys, getEntry).includes("assistant:gone"));
  });

  it("preserves order, dropping rows rather than moving them", () => {
    const kept = ownKeys(KEYS, getEntry);
    const positions = kept.map((key) => KEYS.indexOf(key));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });
});
