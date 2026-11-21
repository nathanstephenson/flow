import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checksSummary, failedRuns, orderedChecks, readableStatus, safePullRequestUrl } from "./pull-request.ts";

const check = (name: string, status: string, runId?: number) => ({ name, status, url: "", ...(runId === undefined ? {} : { runId, jobId: 1 }) });

describe("pull request presentation", () => {
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
