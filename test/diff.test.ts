import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { editDiff, textDiff } from "../src/client/diff.ts";

describe("text diffs", () => {
  const unified = "diff --git a/a.txt b/a.txt\nindex 123..456 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n";

  it("colours only changed lines in unified output and leaves metadata neutral", () => {
    const lines = textDiff(unified)!;
    assert.deepEqual(lines.map((line) => line.kind), [
      "context", "context", "context", "context", "context", "context", "removed", "added", "context",
    ]);
    assert.equal(lines.map((line) => line.text).join(""), unified);
  });

  it("accepts explicit diff/patch fragments, including streaming and blank changed lines", () => {
    for (const lang of ["diff", "patch", "DIFF filename.txt"]) {
      assert.deepEqual(textDiff("-old\n+\n+unfinished", lang), [
        { text: "-old\n", kind: "removed" },
        { text: "+\n", kind: "added" },
        { text: "+unfinished", kind: "added" },
      ]);
    }
    assert.deepEqual(textDiff("", "diff"), []);
  });

  it("does not colour ordinary code, prose or tool output", () => {
    for (const text of ["+positive\n-negative", "--- a\n+++ b", "@@ -1 +1 @@\n-old\n+new", "", "git status"]) {
      assert.equal(textDiff(text), undefined);
    }
    assert.equal(textDiff(unified, "text"), undefined);
    assert.equal(textDiff("+counter;\n-value;", "javascript"), undefined);
  });

  it("distinguishes file headers from similarly prefixed content inside hunks", () => {
    const text = "--- a/one\n+++ b/one\n@@ -1 +1 @@\n--- content\n+++ content\n--- a/two\n+++ b/two\n@@ -0,0 +1 @@\n+added\n+ordinary output";
    assert.deepEqual(textDiff(text)!.map((line) => line.kind), [
      "context", "context", "context", "removed", "added", "context", "context", "context", "added", "context",
    ]);
  });

  it("preserves CRLF, empty lines, tabs, HTML and the final newline exactly", () => {
    const text = "--- a\r\n+++ b\r\n@@ -1 +1 @@\r\n-\t<script>\r\n+\tnew\r\n\r\n";
    const lines = textDiff(text)!;
    assert.equal(lines.map((line) => line.text).join(""), text);
    assert.equal(lines[3]!.kind, "removed");
    assert.equal(lines[4]!.kind, "added");
  });
});

describe("edit diffs", () => {
  it("reads the shape Claude's Edit tool actually produces", () => {
    // Captured from a real session: {replace_all, file_path, old_string, new_string}.
    const diff = editDiff({
      replace_all: false,
      file_path: "/tmp/gh-demo/greeting.txt",
      old_string: "Hello, world!",
      new_string: "Goodbye, world!",
    });
    assert.deepEqual(diff, {
      path: "/tmp/gh-demo/greeting.txt",
      removed: ["Hello, world!"],
      added: ["Goodbye, world!"],
    });
  });

  it("treats a Write as pure addition", () => {
    assert.deepEqual(editDiff({ file_path: "a.txt", content: "one\ntwo\n" }), {
      path: "a.txt",
      removed: [],
      added: ["one", "two"],
    });
  });

  it("leaves non-editing tools alone", () => {
    assert.equal(editDiff({ file_path: "a.txt" }), undefined);
    assert.equal(editDiff("ls -la"), undefined);
    assert.equal(editDiff(undefined), undefined);
  });
});
