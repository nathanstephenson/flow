import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { resultText, toolKind, toolOutcome } from "./tool-display.ts";

type Tool = Extract<Entry, { kind: "tool" }>;
const tool = (patch: Partial<Tool>): Tool => ({ kind: "tool", id: "t", name: "Bash", input: {}, status: "complete", ...patch });

describe("how a tool call is shown", () => {
  it("names the kind of tool for its icon", () => {
    assert.equal(toolKind("Bash"), "shell");
    assert.equal(toolKind("Read"), "read");
    assert.equal(toolKind("MultiEdit"), "edit");
    assert.equal(toolKind("Grep"), "search");
    assert.equal(toolKind("Glob"), "list");
    assert.equal(toolKind("WebFetch"), "web");
    assert.equal(toolKind("mcp__github__get_me"), "mcp");
    assert.equal(toolKind("Something"), "other");
  });

  it("reads result text from strings and content blocks", () => {
    assert.equal(resultText("a\nb"), "a\nb");
    assert.equal(resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
    assert.equal(resultText({ content: [{ type: "text", text: "c" }] }), "c");
    assert.equal(resultText({ exitCode: 0 }), undefined);
  });

  it("sums up a finished call only where it can", () => {
    assert.equal(toolOutcome(tool({ status: "error" })), "failed");
    assert.equal(toolOutcome(tool({ status: "running" })), undefined);
    assert.equal(toolOutcome(tool({ name: "Read", result: "one\ntwo\n" })), "2 lines");
    assert.equal(toolOutcome(tool({ name: "Glob", result: "a.ts" })), "1 file");
    assert.equal(toolOutcome(tool({ name: "Grep", result: [{ type: "text", text: "x\ny\nz" }] })), "3 results");
    assert.equal(toolOutcome(tool({ name: "Bash", result: "output" })), undefined);
    assert.equal(toolOutcome(tool({ name: "Edit", input: { old_string: "a", new_string: "b\nc" } })), "+2 −1");
  });
});
