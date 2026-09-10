import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { entryKey } from "./entry-key.ts";
import { memberKeys, ownKeys, producerKey, subagentKey } from "./subagent-rows.ts";

const parentSaid: Entry = { kind: "assistant", id: "m1", text: "dispatching", final: true };
const subagentEntry: Entry = { kind: "subagent", id: "call_1", name: "Explore", status: "running", startedAt: "2026-01-01T00:00:00.000Z" };
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
/** The call that spawned the Subagent: same id as its `subagent` Entry, by design (ADR 0015). */
const spawningCall: Entry = { kind: "tool", id: "call_1", name: "Agent", input: {}, status: "complete" };

/** A backgrounded call and its own tool row, which share an id the way a Subagent's pair does. */
const backgroundedCall: Entry = { kind: "tool", id: "call_2", name: "Bash", input: { command: "npm test -- --watch" }, status: "complete" };
const backgroundCard: Entry = { kind: "background_call", id: "call_2", tool: "Bash", status: "running", startedAt: "2026-01-01T00:00:00.000Z" };

const ENTRIES = [parentSaid, spawningCall, subagentEntry, childSaid, childTool, parentTool, backgroundedCall, backgroundCard];
const KEYS = ENTRIES.map(entryKey);
const getEntry = (key: string): Entry | undefined => ENTRIES.find((entry) => entryKey(entry) === key);

describe("splitting a Subagent's rows from the session's own", () => {
  it("recognises a row by the producer it already carries", () => {
    assert.equal(producerKey(childSaid), "subagent:call_1");
    assert.equal(producerKey(parentSaid), undefined, "the session's own work belongs to no Subagent");
  });

  it("keeps the session's own rows and drops what a Subagent produced", () => {
    // The main transcript's whole job now: the session's work, plus one row per Subagent started.
    assert.deepEqual(ownKeys(KEYS, getEntry), [
      entryKey(parentSaid),
      entryKey(subagentEntry),
      entryKey(parentTool),
      entryKey(backgroundedCall),
      entryKey(backgroundCard),
    ]);
  });

  it("keeps both rows of a Background Call, unlike a Subagent's pair", () => {
    /*
     * The assertion that stops someone completing the pattern. A Background Call shares its id with
     * a `tool` row too, so the key arithmetic above would happily drop it — but that row carries the
     * command and the launch receipt, which the card cannot, so it is not the same two views of one
     * thing a Subagent's pair is (ADR 0021).
     */
    const kept = ownKeys(KEYS, getEntry);
    assert.ok(kept.includes(entryKey(backgroundedCall)), "the command lives on the tool row and nowhere else");
    assert.ok(kept.includes(entryKey(backgroundCard)), "and the status lives on the card");
    assert.ok(!kept.includes(entryKey(spawningCall)), "while a Subagent's spawning row still goes");
  });

  it("drops the tool call that spawned a Subagent, keeping only the Subagent's own row", () => {
    // Both carry the same brief and sit adjacent; only the Subagent row carries a status. Leaving
    // both in showed every Subagent twice.
    const kept = ownKeys(KEYS, getEntry);
    assert.ok(!kept.includes(entryKey(spawningCall)), "the spawning call must not appear beside the card");
    assert.ok(kept.includes(entryKey(subagentEntry)));
  });

  it("leaves an ordinary tool call alone", () => {
    // The rule is about the pairing, not about tool calls in general.
    assert.ok(ownKeys(KEYS, getEntry).includes(entryKey(parentTool)));
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
