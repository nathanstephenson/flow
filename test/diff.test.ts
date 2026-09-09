import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { editDiff } from "../src/client/diff.ts";

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
