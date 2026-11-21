import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraftBlock, checksSummary, failedCheck, failedRuns, matchesSummary, orderedChecks, readableStatus, safePullRequestUrl, threadDraftBlock } from "./pull-request.ts";

const check = (name: string, status: string, runId?: number) => ({ name, status, url: "", ...(runId === undefined ? {} : { runId, jobId: 1 }) });

describe("pull request presentation", () => {
  it("matches a loaded pull request to a summary by update time, state and checks", () => {
    const thread = (isResolved: boolean) => ({ id: "T", path: "a.ts", line: 1, isOutdated: false, isResolved, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, diffHunk: "", comments: [] });
    const loaded = { number: 4, updatedAt: "u1", state: "OPEN" as const, isDraft: false, reviewDecision: null, threads: [thread(false), thread(true)], checks: [check("a", "SUCCESS"), check("b", "IN_PROGRESS")] };
    const summary = { number: 4, url: "", updatedAt: "u1", state: "OPEN" as const, isDraft: false, checks: "pending" as const, checksCompleted: 1, reviewDecision: null, unresolvedThreads: 1 };
    assert.equal(matchesSummary(loaded, summary), true);
    assert.equal(matchesSummary(loaded, undefined), false);
    for (const change of [{ number: 5 }, { updatedAt: "u2" }, { state: "MERGED" as const }, { isDraft: true }, { checks: "failing" as const }, { checksCompleted: 2 }, { unresolvedThreads: 0 }, { reviewDecision: "APPROVED" }]) assert.equal(matchesSummary(loaded, { ...summary, ...change }), false);
    assert.equal(matchesSummary({ ...loaded, checks: [] }, { ...summary, checks: "none", checksCompleted: 0 }), true);
    assert.equal(matchesSummary({ ...loaded, checks: [check("a", "SUCCESS"), check("b", "FAILURE")] }, { ...summary, checks: "failing", checksCompleted: 2 }), true);
    assert.equal(matchesSummary({ ...loaded, checks: [check("a", "SUCCESS"), check("b", "SKIPPED")] }, { ...summary, checks: "passing", checksCompleted: 2 }), true);
  });

  it("permits only absolute web links", () => {
    assert.equal(safePullRequestUrl("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1");
    assert.equal(safePullRequestUrl("http://example.com"), "http://example.com/");
    for (const url of ["javascript:alert(1)", "data:text/html,test", "//example.com", "/relative", "bad"]) assert.equal(safePullRequestUrl(url), undefined);
  });
  it("summarises CI without treating unknown checks as passing", () => {
    assert.equal(checksSummary([]), "No checks reported.");
    assert.equal(checksSummary([check("a", "SUCCESS"), check("b", "ERROR"), check("c", "IN_PROGRESS"), check("d", "COMPLETED")]), "1 passed · 1 failed · 1 pending · 1 unknown");
    assert.equal(readableStatus("CHANGES_REQUESTED"), "Changes requested");
  });
  it("orders failing checks first, then pending, then the others", () => {
    assert.deepEqual(orderedChecks([check("pass", "SUCCESS"), check("wait", "QUEUED"), check("fail", "FAILURE"), check("odd", "COMPLETED"), check("error", "TIMED_OUT")]).map(value => value.name), ["fail", "error", "wait", "pass", "odd"]);
  });
  it("groups failed checks by GitHub Actions run, once per run", () => {
    assert.deepEqual(failedRuns([check("a", "FAILURE", 7), check("b", "FAILURE", 7), check("c", "CANCELLED", 8), check("d", "SUCCESS", 9), check("e", "FAILURE"), check("f", "QUEUED", 10)]), [{ runId: 7, names: ["a", "b"] }, { runId: 8, names: ["c"] }]);
    assert.deepEqual(failedRuns([check("d", "SUCCESS", 9)]), []);
  });
  it("tells a failed check from the others", () => {
    assert.deepEqual([check("a", "FAILURE"), check("b", "cancelled"), check("c", "SUCCESS"), check("d", "QUEUED"), check("e", "COMPLETED")].map(failedCheck), [true, true, false, false, false]);
  });
});

const thread = (extra: object = {}) => ({
  id: "T1", path: "src/a.ts", line: 4, isOutdated: false, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true,
  diffHunk: "@@ -1,2 +1,2 @@\n-old\n+new",
  comments: [{ id: "C1", author: "alice", body: "Rename this.", url: "", createdAt: "" }],
  ...extra,
});

describe("Draft blocks", () => {
  it("writes a review thread with its place, diff hunk and comment", () => {
    assert.equal(threadDraftBlock(thread()), "Review thread on src/a.ts line 4:\n\n```diff\n@@ -1,2 +1,2 @@\n-old\n+new\n```\n\nComment by alice:\nRename this.");
  });
  it("says that a thread is outdated, and gives each comment with its author, including a deleted one", () => {
    const block = threadDraftBlock(thread({ isOutdated: true, line: null, diffHunk: "", comments: [
      { id: "C1", author: "alice", body: "First.", url: "", createdAt: "" },
      { id: "C2", author: "[deleted]", body: "Second\nline.", url: "", createdAt: "" },
    ] }));
    assert.equal(block, "Review thread on src/a.ts:\nThis thread is outdated.\n\nComment by alice:\nFirst.\n\nComment by [deleted]:\nSecond\nline.");
  });
  it("uses a longer fence when the content has backticks", () => {
    const block = threadDraftBlock(thread({ diffHunk: "+const a = ```x```;\n+const b = `y`;" }));
    assert.match(block, /\n````diff\n\+const a = ```x```;\n\+const b = `y`;\n````\n/);
    assert.match(checkDraftBlock({ name: "test", status: "FAILURE", url: "u" }, { text: "a ````` b", truncated: false }), /\n``````text\na ````` b\n``````$/);
  });
  it("writes a failed check with its URL and job log", () => {
    const check = { name: "test", status: "FAILURE", url: "https://github.com/o/r/actions/runs/1/job/2", runId: 1, jobId: 2 };
    assert.equal(checkDraftBlock(check, { text: "error: failed", truncated: false }), "Failed check: test\nURL: https://github.com/o/r/actions/runs/1/job/2\n\nJob log:\n```text\nerror: failed\n```");
    assert.equal(checkDraftBlock(check, { text: "error: failed", truncated: true }), "Failed check: test\nURL: https://github.com/o/r/actions/runs/1/job/2\n\nEnd of the job log:\n```text\nerror: failed\n```");
    assert.equal(checkDraftBlock(check), "Failed check: test\nURL: https://github.com/o/r/actions/runs/1/job/2");
  });
});
