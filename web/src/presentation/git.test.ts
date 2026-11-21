import assert from "node:assert/strict";
import { it } from "node:test";
import { diffHunks, diffNotice, gitStateLine, noChanges } from "./git.ts";

const local = { revision: "r", changed: 0, ahead: 2, behind: 1, upstream: true };
const pr = { number: 12, url: "https://github.com/test/repo/pull/12", state: "OPEN" as const, isDraft: false, checks: "pending" as const, reviewDecision: null, unresolvedThreads: 0, updatedAt: "2025-01-01" };

it("shows ahead, behind and the pull request check status", () => {
  assert.equal(gitStateLine(local), "2 ahead, 1 behind");
  assert.equal(gitStateLine({ ...local, upstream: false }), "No upstream branch");
  assert.equal(gitStateLine({ ...local, pr }), "2 ahead, 1 behind · PR #12 · Checks pending");
  assert.equal(gitStateLine({ ...local, pr: { ...pr, checks: "none" } }), "2 ahead, 1 behind · PR #12 · No checks");
});

it("names diffs that have no text and empty views", () => {
  assert.equal(diffNotice({ binary: true }, "a.png"), "Binary file. No text diff.");
  assert.equal(diffNotice({ binary: true }, "nested/"), "Directory. No text diff.");
  assert.equal(diffNotice({ tooLarge: true }, "a.txt"), "This diff is too large to show.");
  assert.equal(diffNotice({ text: "" }, "a.txt"), "No text changes.");
  assert.equal(noChanges("uncommitted"), "No uncommitted changes.");
  assert.equal(noChanges("branch"), "No changes on this branch.");
});

it("shows a diff from its first hunk", () => {
  assert.equal(diffHunks("diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"), "@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(diffHunks("--- /dev/null\n+++ b/a\n@@ -0,0 +1,1 @@\n+@@ x\n"), "@@ -0,0 +1,1 @@\n+@@ x\n");
  assert.equal(diffHunks("diff --git a/a b/a\nold mode 100644\nnew mode 100755\n"), undefined);
  assert.equal(diffHunks(""), undefined);
});
