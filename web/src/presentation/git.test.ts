import assert from "node:assert/strict";
import { it } from "node:test";
import { branchLine, diffHunks, diffNotice, gitStateLine, gitSteps, noChanges, pullRequestBadges, pullRequestLine, pullStep } from "./git.ts";

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

it("lists the Git steps that apply, the next step first", () => {
  const clean = { ...local, defaultBranch: "main", ahead: 0, behind: 0 };
  assert.deepEqual(gitSteps(undefined), []);
  assert.deepEqual(gitSteps({ ...clean, changed: 2 }), ["commit", "pull_request"]);
  assert.deepEqual(gitSteps({ ...clean, changed: 2, ahead: 1 }), ["commit", "push"]);
  assert.deepEqual(gitSteps({ ...clean, upstream: false }), ["push"]);
  assert.deepEqual(gitSteps({ ...clean, ahead: 1 }), ["push"]);
  assert.deepEqual(gitSteps({ ...clean, ahead: 1, behind: 2 }), ["push"]);
  assert.deepEqual(gitSteps({ ...clean, behind: 2 }), ["pull_request"]);
  assert.deepEqual(gitSteps(clean), ["pull_request"]);
  assert.deepEqual(gitSteps({ ...clean, pr: { ...pr, state: "CLOSED" } }), ["pull_request"]);
  assert.deepEqual(gitSteps({ ...clean, pr: { ...pr, state: "MERGED" } }), ["pull_request"]);
  assert.deepEqual(gitSteps({ ...clean, pr }), []);
  assert.deepEqual(gitSteps({ ...clean, pr: { ...pr, isDraft: true } }), []);
  assert.deepEqual(gitSteps({ ...clean, branch: "main", ahead: 1, upstream: false }), []);
  assert.deepEqual(gitSteps({ ...clean, branch: "main", changed: 1 }), ["commit"]);
  assert.deepEqual(gitSteps({ ...detached, ahead: 0, behind: 0, upstream: false }), []);
  assert.deepEqual(gitSteps({ ...unborn, ahead: 0, behind: 0, upstream: false }), []);
});

it("offers Pull only when the branch is behind, clean and not diverged", () => {
  const clean = { ...local, ahead: 0, behind: 0 };
  assert.equal(pullStep(undefined), undefined);
  assert.equal(pullStep(clean), undefined);
  assert.equal(pullStep({ ...clean, behind: 2 }), "pull");
  assert.equal(pullStep({ ...clean, behind: 2, changed: 1 }), undefined);
  assert.equal(pullStep({ ...detached, ahead: 0 }), undefined);
  const diverged = { diverged: "This branch and its upstream have diverged." };
  assert.deepEqual(pullStep({ ...clean, ahead: 1, behind: 2 }), diverged);
  assert.deepEqual(pullStep({ ...clean, ahead: 1, behind: 2, changed: 1 }), diverged);
  assert.deepEqual(pullStep({ ...clean, defaultBranch: "feature", ahead: 1, behind: 2 }), { diverged: "This branch and its upstream have diverged. Rebase or merge in the Shell." });
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

it("labels and tones the pull request state and check status for each value", () => {
  for (const [state, isDraft, label, tone] of [["OPEN", true, "Draft", "muted"], ["OPEN", false, "Open", "positive"], ["MERGED", false, "Merged", "merged"], ["CLOSED", false, "Closed", "negative"], ["CLOSED", true, "Closed", "negative"]] as const) {
    assert.deepEqual(pullRequestBadges({ ...pr, state, isDraft }).state, { label, tone });
  }
  for (const [checks, label, tone] of [["passing", "Checks passing", "positive"], ["failing", "Checks failing", "negative"], ["pending", "Checks pending", "pending"]] as const) {
    assert.deepEqual(pullRequestBadges({ ...pr, checks }).checks, { label, tone });
  }
  assert.equal(pullRequestBadges({ ...pr, checks: "none" }).checks, undefined);
});
