import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toolChains, type Segment } from "../src/client/tool-chains.ts";

const entries = (...keys: string[]): Segment[] => keys.map((key) => ({ kind: "entry", key }));

describe("a run of adjacent tool calls", () => {
  it("leaves a transcript with no tool calls alone", () => {
    assert.deepEqual(toolChains(["user:1", "assistant:2"]), entries("user:1", "assistant:2"));
  });

  it("does not chain a pair — two rows are not a flood", () => {
    assert.deepEqual(toolChains(["tool:1", "tool:2", "assistant:3"]), entries("tool:1", "tool:2", "assistant:3"));
  });

  it("chains three", () => {
    assert.deepEqual(toolChains(["tool:1", "tool:2", "tool:3"]), [
      { kind: "chain", keys: ["tool:1", "tool:2", "tool:3"] },
    ]);
  });

  it("breaks a run on anything that is not a tool call", () => {
    assert.deepEqual(
      toolChains(["tool:1", "tool:2", "tool:3", "assistant:4", "tool:5", "tool:6", "tool:7"]),
      [
        { kind: "chain", keys: ["tool:1", "tool:2", "tool:3"] },
        { kind: "entry", key: "assistant:4" },
        { kind: "chain", keys: ["tool:5", "tool:6", "tool:7"] },
      ],
    );
  });

  it("chains a run at the head and at the tail of the list", () => {
    assert.deepEqual(toolChains(["tool:1", "tool:2", "tool:3", "assistant:4"]), [
      { kind: "chain", keys: ["tool:1", "tool:2", "tool:3"] },
      { kind: "entry", key: "assistant:4" },
    ]);
    assert.deepEqual(toolChains(["assistant:0", "tool:1", "tool:2", "tool:3"]), [
      { kind: "entry", key: "assistant:0" },
      { kind: "chain", keys: ["tool:1", "tool:2", "tool:3"] },
    ]);
  });

  it("keeps a subagent card out of the chain it interrupts", () => {
    assert.deepEqual(
      toolChains(["tool:1", "tool:2", "subagent:a", "tool:3", "tool:4"]),
      entries("tool:1", "tool:2", "subagent:a", "tool:3", "tool:4"),
    );
  });

  it("reaches across the thinking a model does between its calls", () => {
    assert.deepEqual(
      toolChains(["tool:1", "thinking:a", "tool:2", "thinking:b", "tool:3"]),
      [{ kind: "chain", keys: ["tool:1", "thinking:a", "tool:2", "thinking:b", "tool:3"] }],
    );
  });

  it("still breaks on prose between two bursts of thinking and tools", () => {
    assert.deepEqual(
      toolChains(["tool:1", "thinking:a", "tool:2", "assistant:3", "tool:4", "thinking:b", "tool:5"]),
      [
        { kind: "chain", keys: ["tool:1", "thinking:a", "tool:2"] },
        { kind: "entry", key: "assistant:3" },
        { kind: "chain", keys: ["tool:4", "thinking:b", "tool:5"] },
      ],
    );
  });

  it("leaves thinking alone when no tool call ran beside it", () => {
    assert.deepEqual(
      toolChains(["thinking:a", "thinking:b", "thinking:c"]),
      entries("thinking:a", "thinking:b", "thinking:c"),
    );
  });
});
