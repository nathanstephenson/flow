import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { entryKey } from "./entry-key.ts";
import { subagentKey, subagentsWithMembers, memberCount, producerKey, visibleKeys } from "./subagent-tree.ts";

const parentSaid: Entry = { kind: "assistant", id: "m1", text: "dispatching", final: true };
const subagent: Entry = { kind: "subagent", id: "call_1", name: "Explore", status: "running" };
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

const ENTRIES = [parentSaid, subagent, childSaid, childTool, parentTool];
const KEYS = ENTRIES.map(entryKey);
const getEntry = (key: string): Entry | undefined => ENTRIES.find((entry) => entryKey(entry) === key);

describe("grouping a Subagent's rows", () => {
  it("recognises a row by the producer it already carries", () => {
    assert.equal(producerKey(childSaid), "subagent:call_1");
    assert.equal(producerKey(parentSaid), undefined, "the session's own work belongs to no Subagent");
  });

  it("draws everything when nothing is collapsed", () => {
    assert.deepEqual(visibleKeys(KEYS, getEntry, new Set()), KEYS);
  });

  it("hides a collapsed Subagent's rows and nothing else", () => {
    const visible = visibleKeys(KEYS, getEntry, new Set([subagentKey("call_1")]));
    assert.deepEqual(visible, [entryKey(parentSaid), entryKey(subagent), entryKey(parentTool)]);
  });

  it("keeps the Subagent's own row, which is the control that undoes the collapse", () => {
    const visible = visibleKeys(KEYS, getEntry, new Set([subagentKey("call_1")]));
    assert.ok(visible.includes(entryKey(subagent)), "collapsing must not hide its own way back");
  });

  it("leaves the parent's own tool call alone", () => {
    const visible = visibleKeys(KEYS, getEntry, new Set([subagentKey("call_1")]));
    assert.ok(visible.includes(entryKey(parentTool)));
  });

  it("preserves order exactly, dropping rows rather than moving them", () => {
    // A filter over an append-only list, never a sort — the property ADR 0015 turns on.
    const visible = visibleKeys(KEYS, getEntry, new Set([subagentKey("call_1")]));
    const positions = visible.map((key) => KEYS.indexOf(key));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  it("counts members over the unfiltered list, so a collapsed one still reports them", () => {
    assert.equal(memberCount(KEYS, getEntry, subagentKey("call_1")), 2);
    assert.equal(memberCount(KEYS, getEntry, subagentKey("nobody")), 0);
  });

  it("lists Subagents that have rows, in the order they first appear", () => {
    assert.deepEqual(subagentsWithMembers(KEYS, getEntry), ["subagent:call_1"]);
  });

  it("tolerates a key with no Entry behind it", () => {
    const visible = visibleKeys([...KEYS, "assistant:gone"], getEntry, new Set([subagentKey("call_1")]));
    assert.ok(visible.includes("assistant:gone"), "an unknown key is drawn, not silently dropped");
  });

  it("returns a copy rather than the caller's array", () => {
    const visible = visibleKeys(KEYS, getEntry, new Set());
    assert.notEqual(visible, KEYS);
    assert.deepEqual(visible, KEYS);
  });
});
