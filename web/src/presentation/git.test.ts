import assert from "node:assert/strict";
import { it } from "node:test";
import { branchLine, diffHunks, diffNotice, gitStateLine, gitSteps, nextStep, noChanges, pullRequestLine } from "./git.ts";

const local = { revision: "r", branch: "feature", head: "0123456789abcdef", changed: 0, ahead: 2, behind: 1, upstream: true };
const { branch: _branch, ...detached } = local;
const { head: _head, ...unborn } = local;
const pr = { number: 12, url: "https://github.com/test/repo/pull/12", state: "OPEN" as const, isDraft: false, checks: "pending" as const, reviewDecision: null, unresolvedThreads: 0, updatedAt: "2025-01-01" };

it("shows the branch, ahead, behind and the pull request state and checks", () => {
  assert.equal(branchLine(local), "feature");
  assert.equal(branchLine(detached), "detached at 0123456");
  assert.equal(gitStateLine(local), "2 ahead, 1 behind");
  assert.equal(gitStateLine({ ...local, upstream: false }), "No upstream branch");
  assert.equal(pullRequestLine(pr), "PR #12 · Open · Checks pending");
  assert.equal(pullRequestLine({ ...pr, isDraft: true, checks: "none" }), "PR #12 · Draft · No checks");
  assert.equal(pullRequestLine({ ...pr, state: "MERGED" }), "PR #12 · Merged · Checks pending");
});

it("chooses the next Git step and keeps the other steps that apply", () => {
  const clean = { ...local, ahead: 0, behind: 0 };
  assert.equal(nextStep(undefined, "main"), undefined);
  assert.equal(nextStep({ ...clean, changed: 2 }, "main"), "commit");
  assert.deepEqual(gitSteps({ ...clean, changed: 2, ahead: 1 }, "main"), ["commit", "push"]);
  assert.equal(nextStep({ ...clean, upstream: false }, "main"), "push");
  assert.equal(nextStep({ ...clean, ahead: 1 }, "main"), "push");
  assert.equal(nextStep(clean, "main"), "pull_request");
  assert.equal(nextStep({ ...clean, pr: { ...pr, state: "MERGED" } }, "main"), "pull_request");
  assert.equal(nextStep({ ...clean, pr }, "main"), undefined);
  assert.equal(nextStep({ ...clean, branch: "main", ahead: 1 }, "main"), undefined);
  assert.equal(nextStep({ ...clean, branch: "main", changed: 1 }, "main"), "commit");
  assert.equal(nextStep({ ...detached, ahead: 0, behind: 0, upstream: false }, "main"), undefined);
  assert.equal(nextStep({ ...unborn, ahead: 0, behind: 0, upstream: false }, undefined), undefined);
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
