import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toolSummary } from "../src/client/tool-summary.ts";

describe("a tool call's argument précis", () => {
  it("names the file an edit or a write touched", () => {
    assert.equal(toolSummary({ file_path: "/repo/src/client/reduce.ts", old_string: "a", new_string: "b" }), "/repo/src/client/reduce.ts");
    assert.equal(toolSummary({ file_path: "/repo/README.md", content: "hello" }), "/repo/README.md");
  });

  it("keeps the end of a long path, which is the part that identifies the file", () => {
    const path = `/repo/${"nested/".repeat(20)}deep.ts`;
    const summary = toolSummary({ file_path: path });

    assert.equal(summary?.startsWith("…"), true);
    assert.equal(summary?.endsWith("nested/deep.ts"), true);
    assert.equal(summary?.length, 60);
  });

  it("shows the beginning of a command, which is the part that says what it does", () => {
    assert.equal(toolSummary({ command: "npm test", description: "run the tests" }), "npm test");

    const long = toolSummary({ command: `git log --oneline ${"--author=someone ".repeat(10)}` });
    assert.equal(long?.startsWith("git log --oneline"), true);
    assert.equal(long?.endsWith("…"), true);
    assert.equal(long?.length, 60);
  });

  it("puts a multi-line command on one line", () => {
    assert.equal(toolSummary({ command: "cd /repo &&\n  npm test" }), "cd /repo && npm test");
  });

  it("shows what a search was searching for", () => {
    assert.equal(toolSummary({ pattern: "entryHaystack", path: "/repo/src", glob: "*.ts" }), "entryHaystack");
    assert.equal(toolSummary({ url: "https://example.com/docs", prompt: "summarise this" }), "https://example.com/docs");
  });

  it("falls back to a lone string argument, whatever the tool is called", () => {
    // A backend this front-end has never heard of, whose input names itself.
    assert.equal(toolSummary({ thought: "the reducer is append-only" }), "the reducer is append-only");
  });

  it("says nothing rather than guessing", () => {
    assert.equal(toolSummary(undefined), undefined);
    assert.equal(toolSummary(null), undefined);
    assert.equal(toolSummary("a bare string"), undefined);
    assert.equal(toolSummary({}), undefined);
    assert.equal(toolSummary({ limit: 20, offset: 0 }), undefined);
    assert.equal(toolSummary({ left: "one", right: "two" }), undefined, "two strings, no way to choose");
    assert.equal(toolSummary({ file_path: "   " }), undefined);
  });
});
