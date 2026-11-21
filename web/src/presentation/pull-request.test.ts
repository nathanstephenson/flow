import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checksSummary, failedRuns, matchesSummary, orderedChecks, readableStatus, safePullRequestUrl } from "./pull-request.ts";

const check = (name: string, status: string, runId?: number) => ({ name, status, url: "", ...(runId === undefined ? {} : { runId, jobId: 1 }) });

describe("pull request presentation", () => {
  it("matches a loaded pull request to a summary by update time, state and checks", () => {
    const loaded = { number: 4, updatedAt: "u1", state: "OPEN" as const, isDraft: false, checks: [check("a", "SUCCESS"), check("b", "IN_PROGRESS")] };
    const summary = { number: 4, url: "", updatedAt: "u1", state: "OPEN" as const, isDraft: false, checks: "pending" as const, checksCompleted: 1, reviewDecision: null, unresolvedThreads: 0 };
    assert.equal(matchesSummary(loaded, summary), true);
    assert.equal(matchesSummary(loaded, undefined), false);
    for (const change of [{ number: 5 }, { updatedAt: "u2" }, { state: "MERGED" as const }, { isDraft: true }, { checks: "failing" as const }, { checksCompleted: 2 }]) assert.equal(matchesSummary(loaded, { ...summary, ...change }), false);
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
});
