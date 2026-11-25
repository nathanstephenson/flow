import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { git, repository } from "./git-fixture.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { MergeMethod, PullRequestDetails, PullRequestRef } from "../src/protocol/pull-request.ts";
import { pullRequest, commentPullRequest, resolvePullRequestThread, changePullRequest, pullBranch, editPullRequest, setPullRequestDraft, rerunPullRequestChecks, checkLog, dropUnchangedBranch, listPullRequests, projectPullRequest, projectTarget, pullRequestRange, submitReview } from "../src/daemon/pull-request.ts";
import { resolveRepository } from "../src/daemon/repository.ts";
import { CommandRefused, SessionHost } from "../src/daemon/host.ts";
import type { Gh } from "../src/daemon/github.ts";

test("Session Host routes all PR commands through Agent Session lookup", async () => {
  const host = new SessionHost();
  for (const command of [
    { type: "pull_request" as const, sessionId: "missing" },
    { type: "comment_pull_request" as const, sessionId: "missing", input: { pr: ref, body: "text" } },
    { type: "resolve_pull_request_thread" as const, sessionId: "missing", input: { pr: ref, threadId: "thread", resolved: true } },
    { type: "edit_pull_request" as const, sessionId: "missing", input: { pr: ref, title: "Title", body: "" } },
    { type: "set_pull_request_draft" as const, sessionId: "missing", input: { pr: ref, draft: true } },
    { type: "rerun_pull_request_checks" as const, sessionId: "missing", input: { pr: ref, runId: 1 } },
    { type: "pull_request_check_log" as const, sessionId: "missing", pr: ref, jobId: 1 },
  ]) await assert.rejects(host.execute(command), /session/i);
});

test("each pull request write polls Git State once for its Scope, and reads run during a turn", async () => {
  const path = await mkdtemp(join(tmpdir(), "flow-pr-host-"));
  execFileSync("git", ["init", "-b", "feature"], { cwd: path });
  const host = new SessionHost();
  host.registerBackend(new FakeBackend());
  const polls: (string | undefined)[] = [];
  host.pollGitState = async (forced?: string) => { polls.push(forced); };
  try {
    const sessionId = await host.create({ scope: path });
    await host.send(sessionId, "work", "now");
    assert.equal(await host.execute({ type: "pull_request", sessionId }), null);
    await assert.rejects(host.execute({ type: "pull_request_check_log", sessionId, pr: ref, jobId: 1 }), /No remote/);
    assert.deepEqual(polls, []);
    for (const command of [
      { type: "comment_pull_request" as const, sessionId, input: { pr: ref, body: "text" } },
      { type: "resolve_pull_request_thread" as const, sessionId, input: { pr: ref, threadId: "thread", resolved: true } },
      { type: "edit_pull_request" as const, sessionId, input: { pr: ref, title: "Title", body: "" } },
      { type: "set_pull_request_draft" as const, sessionId, input: { pr: ref, draft: false } },
      { type: "rerun_pull_request_checks" as const, sessionId, input: { pr: ref, runId: 7 } },
    ]) {
      const before: number = polls.length;
      await assert.rejects(host.execute(command), /No remote/, command.type);
      assert.deepEqual(polls.slice(before), [path], command.type);
    }
  } finally { await host.shutdown(); await rm(path, { recursive: true, force: true }); }
});

test("pull_request answers no Pull Request without a github.com remote and refuses a failed read", async () => {
  const path = await mkdtemp(join(tmpdir(), "flow-pr-none-"));
  execFileSync("git", ["init", "-b", "feature"], { cwd: path });
  const host = new SessionHost();
  host.registerBackend(new FakeBackend());
  try {
    const sessionId = await host.create({ scope: path });
    assert.equal(await host.execute({ type: "pull_request", sessionId }), null);
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/test/repo.git"], { cwd: path });
    assert.equal(await host.execute({ type: "pull_request", sessionId }), null);
    execFileSync("git", ["remote", "add", "other", "https://gitlab.com/test/other.git"], { cwd: path });
    execFileSync("git", ["remote", "remove", "origin"], { cwd: path });
    execFileSync("git", ["remote", "add", "second", "git@github.com:test/repo.git"], { cwd: path });
    await assert.rejects(host.execute({ type: "pull_request", sessionId }), (error: unknown) => error instanceof CommandRefused && /push remote/.test(error.message));
  } finally { await host.shutdown(); await rm(path, { recursive: true, force: true }); }
});

test("refresh_git forces one pull request poll only when asked", async () => {
  const path = await mkdtemp(join(tmpdir(), "flow-pr-refresh-"));
  execFileSync("git", ["init", "-b", "feature"], { cwd: path });
  const host = new SessionHost();
  host.registerBackend(new FakeBackend());
  const polls: (string | undefined)[] = [];
  host.pollGitState = async (forced?: string) => { polls.push(forced); };
  try {
    const sessionId = await host.create({ scope: path });
    await host.execute({ type: "refresh_git", sessionId });
    assert.deepEqual(polls, []);
    await host.execute({ type: "refresh_git", sessionId, pullRequest: true });
    assert.deepEqual(polls, [path]);
  } finally { await host.shutdown(); await rm(path, { recursive: true, force: true }); }
});

test("reads a pull request with 3 threads and 5 checks in one gh call", async () => {
  const path = await scope();
  try {
    const { github, calls } = mock({ threads: 3, checks: 5 });
    await resolveRepository(path, "feature", github);
    calls.length = 0;
    const pr = await pullRequest(path, ref, github);
    assert.equal(calls.length, 1);
    assert.equal(pr?.threads.length, 3);
    assert.equal(pr?.threads[0]?.comments.length, 1);
    assert.equal(pr?.threads[0]?.diffHunk, entry.diffHunk);
    assert.equal(pr?.checks.length, 5);
    assert.equal(pr?.comments.length, 1);
    assert.equal(pr?.reviews[0]?.state, "APPROVED");
    assert.equal(pr?.headRefOid, "a".repeat(40));
    assert.equal(pr?.headRepository, "fork/repo");
    assert.equal(pr?.body, entry.body);
    assert.equal(pr?.updatedAt, "2025-01-02");
    assert.match(calls[0]!.find(arg => arg.startsWith("query="))!, /reviewDecision updatedAt /);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("pages only a connection whose first page has more", async () => {
  const path = await scope();
  try {
    const { github, calls } = mock({ threads: 3, more: "thread" });
    await resolveRepository(path, "feature", github);
    calls.length = 0;
    const pr = await pullRequest(path, ref, github);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.join(" "), /PullRequestReviewThread\{comments\(first:100,after:\$cursor\)/);
    assert.ok(calls[1]!.includes("id=PRRT_1") && calls[1]!.includes("cursor=next"));
    assert.deepEqual(pr?.threads.map(thread => thread.comments.length), [1, 2, 1]);
    for (const [more, read] of [["comments", (value: PullRequestDetails) => value.comments], ["reviews", (value: PullRequestDetails) => value.reviews], ["threads", (value: PullRequestDetails) => value.threads], ["checks", (value: PullRequestDetails) => value.checks]] as const) {
      const paged = mock({ more });
      const result = await pullRequest(path, ref, paged.github);
      assert.equal(paged.calls.length, 2, more);
      assert.equal(read(result!).length, 2, more);
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("reads through the resolver when no pull request is known or the known one is from another branch", async () => {
  const path = await scope();
  try {
    const unknown = mock();
    await resolveRepository(path, "feature", unknown.github);
    unknown.calls.length = 0;
    assert.equal((await pullRequest(path, undefined, unknown.github))?.id, ref.id);
    assert.equal(unknown.calls.length, 2);
    const other = mock({ elsewhere: "PR_old" });
    const read = await pullRequest(path, { ...ref, id: "PR_old" }, other.github);
    assert.equal(read?.id, ref.id);
    assert.equal(read?.headRefName, "feature");
    assert.equal(other.calls.length, 3);
    assert.equal(await pullRequest(path, undefined, mock({ candidates: [] }).github), null);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("parses run and job IDs from GitHub Actions details URLs only", async () => {
  const path = await scope();
  try {
    const pr = await pullRequest(path, ref, mock({ checkNodes: [
      { name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/base/repo/actions/runs/123/job/456" },
      { name: "external", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example.com/actions/runs/1/job/2" },
      { context: "status", state: "PENDING", targetUrl: "https://example.com/status" },
      { name: "queued", status: "QUEUED", conclusion: null, detailsUrl: null },
    ] }).github);
    assert.deepEqual(pr?.checks, [
      { name: "test", status: "FAILURE", url: "https://github.com/base/repo/actions/runs/123/job/456", runId: 123, jobId: 456 },
      { name: "external", status: "SUCCESS", url: "https://ci.example.com/actions/runs/1/job/2" },
      { name: "status", status: "PENDING", url: "https://example.com/status" },
      { name: "queued", status: "QUEUED", url: "" },
    ]);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("handles comment locks and merge permissions", async () => {
  const path = await scope();
  try {
    assert.equal((await pullRequest(path, ref, mock().github))?.viewerCanComment, true);
    assert.equal((await pullRequest(path, ref, mock({ locked: true }).github))?.viewerCanComment, false);
    assert.equal((await pullRequest(path, ref, mock({ locked: true, permission: "WRITE" }).github))?.viewerCanComment, true);
    assert.equal((await pullRequest(path, ref, mock({ archived: true, permission: "ADMIN" }).github))?.viewerCanComment, false);
    assert.deepEqual((await pullRequest(path, ref, mock({ permission: "WRITE", methods: ["SQUASH", "REBASE"] }).github))?.mergeMethods, ["SQUASH", "REBASE"]);
    assert.deepEqual((await pullRequest(path, ref, mock({ methods: ["SQUASH"] }).github))?.mergeMethods, []);
    await assert.rejects(pullRequest(path, ref, async (_, args) => args[0] === "repo" ? repositoryView(args) : JSON.stringify({ errors: [{ message: "API failure" }] })), /API failure/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a comment is one identity check and one mutation, without a full read", async () => {
  const path = await scope();
  try {
    const { github, calls, mutations } = mock();
    await resolveRepository(path, "feature", github);
    calls.length = 0;
    const body = 'hello "quoted"\n![image](url)';
    await commentPullRequest(path, { pr: ref, body }, github);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.join(" "), /headRefName:\$branch/);
    assert.ok(calls.every(call => !call.join(" ").includes("reviewThreads(first:100){nodes{id")));
    assert.ok(mutations[0]!.includes(`body=${body}`) && mutations[0]!.includes(`id=${ref.id}`));
    await commentPullRequest(path, { pr: ref, body, threadId: "PRRT_1" }, github);
    await resolvePullRequestThread(path, { pr: ref, threadId: "PRRT_1", resolved: true }, github);
    await resolvePullRequestThread(path, { pr: ref, threadId: "PRRT_1", resolved: false }, github);
    assert.match(mutations[1]!.join(" "), /addPullRequestReviewThreadReply/);
    assert.match(mutations[2]!.join(" "), /resolveReviewThread/);
    assert.match(mutations[3]!.join(" "), /unresolveReviewThread/);
    assert.ok(mutations.slice(1).every(args => args.includes("id=PRRT_1")));
    const failure = mock({ fail: true });
    await assert.rejects(commentPullRequest(path, { pr: ref, body }, failure.github), /denied/);
    assert.equal(failure.mutations.length, 1);
  } finally { await rm(path, { recursive: true, force: true }); }
});

const writes: [string, (path: string, pr: PullRequestRef, github: Gh) => Promise<unknown>][] = [
  ["comment", (path, pr, github) => commentPullRequest(path, { pr, body: "text" }, github)],
  ["reply", (path, pr, github) => commentPullRequest(path, { pr, body: "text", threadId: "PRRT_1" }, github)],
  ["resolve", (path, pr, github) => resolvePullRequestThread(path, { pr, threadId: "PRRT_1", resolved: true }, github)],
  ["edit", (path, pr, github) => editPullRequest(path, { pr, title: "Title", body: "" }, github)],
  ["draft", (path, pr, github) => setPullRequestDraft(path, { pr, draft: true }, github)],
  ["rerun", (path, pr, github) => rerunPullRequestChecks(path, { pr, runId: 7 }, github)],
  ["merge", (path, pr, github) => changePullRequest(path, "merge", { ...actionInput, pr, method: "MERGE" }, github)],
  ["rebase", (path, pr, github) => changePullRequest(path, "rebase", { ...actionInput, pr }, github)],
];

test("refuses each write with a stale pull request reference before any mutation", async () => {
  const path = await scope();
  try {
    for (const [name, write] of writes) {
      for (const [options, pr] of [[{ candidates: [] }, ref], [{ candidates: [{ ...open, id: "PR_two", number: 2 }] }, ref], [{}, { ...ref, id: "other" }], [{}, { ...ref, repo: "other/repo" }], [{}, { ...ref, number: 2 }]] as const) {
        const { github, mutations, calls } = mock(options);
        await assert.rejects(write(path, pr, github), /changed/, name);
        assert.equal(mutations.length, 0, name);
        assert.ok(!calls.some(call => call[0] === "run"), name);
      }
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

for (const method of ["MERGE", "SQUASH", "REBASE"] as const) test(`merges with ${method} and the expected head`, async () => {
  const path = await scope();
  try {
    const { github, mutations, calls } = mock();
    await changePullRequest(path, "merge", { ...actionInput, method }, github);
    assert.equal(calls.filter(call => call[0] === "api").length, 2);
    assert.equal(mutations.length, 1);
    assert.match(mutations[0]!.join(" "), /mergePullRequest\(input:\{pullRequestId:\$id,expectedHeadOid:\$head,mergeMethod:\$method\}/);
    assert.ok(mutations[0]!.includes(`head=${actionInput.headOid}`));
    assert.ok(mutations[0]!.includes(`method=${method}`));
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("refuses a merge of a changed, closed or draft pull request, or with an invalid method, without mutations", async () => {
  const path = await scope();
  try {
    for (const [options, method] of [[{ state: "CLOSED" }, "MERGE"], [{ state: "MERGED" }, "MERGE"], [{ headOid: "b".repeat(40) }, "MERGE"], [{ baseBranch: "other" }, "MERGE"], [{ draft: true }, "MERGE"], [{}, "FAST"], [{}, undefined]] as const) {
      const { github, mutations } = mock(options);
      await assert.rejects(changePullRequest(path, "merge", { ...actionInput, ...(method ? { method: method as MergeMethod } : {}) }, github));
      assert.equal(mutations.length, 0);
    }
    const failure = mock({ fail: true });
    await assert.rejects(changePullRequest(path, "merge", { ...actionInput, method: "MERGE" }, failure.github), /denied/);
    assert.equal(failure.mutations.length, 1);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("edits the title and body, and refuses an empty title without a gh call", async () => {
  const path = await scope();
  try {
    const { github, mutations, calls } = mock();
    await editPullRequest(path, { pr: ref, title: "New title", body: "New\nbody" }, github);
    assert.equal(mutations.length, 1);
    assert.match(mutations[0]!.join(" "), /updatePullRequest\(input:\{pullRequestId:\$id,title:\$title,body:\$body\}/);
    assert.ok(mutations[0]!.includes("title=New title") && mutations[0]!.includes("body=New\nbody") && mutations[0]!.includes(`id=${ref.id}`));
    calls.length = 0;
    for (const input of [{ pr: ref, title: " ", body: "" }, { pr: ref, title: "Title", body: 1 }, { pr: { ...ref, number: 0 }, title: "Title", body: "" }]) {
      await assert.rejects(editPullRequest(path, input as never, github), /Invalid|Enter/);
    }
    assert.equal(calls.length, 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("converts to draft and marks ready for review", async () => {
  const path = await scope();
  try {
    const { github, mutations, calls } = mock();
    await setPullRequestDraft(path, { pr: ref, draft: true }, github);
    await setPullRequestDraft(path, { pr: ref, draft: false }, github);
    assert.match(mutations[0]!.join(" "), /convertPullRequestToDraft\(input:\{pullRequestId:\$id\}/);
    assert.match(mutations[1]!.join(" "), /markPullRequestReadyForReview\(input:\{pullRequestId:\$id\}/);
    assert.ok(mutations.every(args => args.includes(`id=${ref.id}`)));
    calls.length = 0;
    await assert.rejects(setPullRequestDraft(path, { pr: ref, draft: "yes" } as never, github), /Invalid/);
    assert.equal(calls.length, 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("re-runs the failed jobs of one run in the base repository, and refuses a bad run ID", async () => {
  const path = await scope();
  try {
    const { github, calls } = mock();
    await rerunPullRequestChecks(path, { pr: ref, runId: 123 }, github);
    assert.deepEqual(calls.filter(call => call[0] === "run"), [["run", "rerun", "123", "--failed", "--repo", "base/repo"]]);
    calls.length = 0;
    for (const runId of [0, -1, 1.5, "12", Number.NaN, undefined]) await assert.rejects(rerunPullRequestChecks(path, { pr: ref, runId } as never, github), /Invalid/);
    assert.equal(calls.length, 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});

const logLine = (text: string, index: number) => `2026-11-21T00:47:${String(index % 60).padStart(2, "0")}.0372247Z \u001b[36;1m${text}\u001b[0m`;

test("reads the end of a failed job log up to its last error, without timestamps or colour", async () => {
  const path = await scope();
  try {
    const lines = [...Array.from({ length: 190 }, (_, index) => `line ${index + 1}`), "##[error]Process completed with exit code 1.", "Post job cleanup.", "Cleaning up orphan processes"];
    const { github, calls } = mock({ log: `\ufeff${lines.map(logLine).join("\n")}\n` });
    const log = await checkLog(path, ref, 456, github);
    assert.equal(log?.truncated, true);
    assert.deepEqual(log?.text.split("\n"), [...lines.slice(111, 190), "##[error]Process completed with exit code 1."]);
    assert.ok(calls.some(call => call.join(" ") === "api repos/base/repo/actions/jobs/456"));
    assert.ok(calls.some(call => call.join(" ") === "api repos/base/repo/actions/jobs/456/logs --allow-escape-sequences"));
    assert.ok(!calls.some(call => call[0] === "run"));
    assert.deepEqual(await checkLog(path, ref, 456, mock({ log: ["one", "two"].map(logLine).join("\r\n") }).github), { text: "one\ntwo", truncated: false });
    const plain = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    assert.deepEqual(await checkLog(path, ref, 456, mock({ log: plain.map(logLine).join("\n") }).github), { text: plain.slice(20).join("\n"), truncated: true });
    const early = ["setup", "##[error]Bad input", ...plain];
    assert.deepEqual(await checkLog(path, ref, 456, mock({ log: early.map(logLine).join("\n") }).github), { text: "setup\n##[error]Bad input", truncated: true });
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("removes every escape sequence and control character from a job log", async () => {
  const path = await scope();
  try {
    const log = "\ufeffplain bom line\n2026-11-21T00:47:01.0Z \u001b]8;;https://evil\u0007link\u001b]8;;\u0007 \u001b[38:5:1mx\u001b(B progress 10%\rprogress 100%\u0008\u0000\u007f\tend\n\ufeff2026-11-21T00:47:02.0Z \u001b]0;title\u001b\\##[error]boom\n";
    assert.deepEqual(await checkLog(path, ref, 456, mock({ log }).github), { text: "plain bom line\nlink x progress 10%\nprogress 100%\tend\n##[error]boom", truncated: false });
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("refuses a job log for a stale pull request, a job of another head, or a bad job ID", async () => {
  const path = await scope();
  try {
    const stale = mock({ log: "x" });
    await assert.rejects(checkLog(path, { ...ref, id: "other" }, 456, stale.github), /changed/);
    assert.ok(!stale.calls.some(call => call[1]?.startsWith("repos/")));
    const other = mock({ log: "x", runSha: "b".repeat(40) });
    await assert.rejects(checkLog(path, ref, 456, other.github), /not for the current head/);
    assert.ok(!other.calls.some(call => call[1]?.endsWith("/logs")));
    const invalid = mock({ log: "x" });
    for (const jobId of [0, -1, 1.5, "12", "12/../runs", Number.NaN, undefined]) await assert.rejects(checkLog(path, ref, jobId as never, invalid.github), /Invalid/);
    assert.equal(invalid.calls.length, 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("gives no job log when the log is too large or cannot be read", async () => {
  const path = await scope();
  try {
    for (const failure of ["GitHub request failed: stdout maxBuffer length exceeded", "GitHub request failed: HTTP 410: Gone"]) {
      assert.equal(await checkLog(path, ref, 456, mock({ log: new Error(failure) }).github), null);
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("pages a thread on a later page whose comments also have a next page", async () => {
  const path = await scope();
  try {
    const { github, calls } = mock({ more: "nested" });
    await resolveRepository(path, "feature", github);
    calls.length = 0;
    const pr = await pullRequest(path, ref, github);
    assert.equal(calls.length, 3);
    assert.match(calls[2]!.join(" "), /PullRequestReviewThread\{comments\(first:100,after/);
    assert.ok(calls[2]!.includes("id=PRRT_more"));
    assert.deepEqual(pr?.threads.map(thread => [thread.id, thread.comments.length]), [["PRRT_0", 1], ["PRRT_more", 2]]);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a known closed pull request is shown until the next poll, even when the resolver now gives another open one", async () => {
  const path = await scope();
  try {
    const { github, calls } = mock({ state: "CLOSED", candidates: [{ ...open, id: "PR_two", number: 2 }] });
    await resolveRepository(path, "feature", github);
    calls.length = 0;
    const pr = await pullRequest(path, ref, github);
    assert.equal(pr?.id, ref.id);
    assert.equal(pr?.state, "CLOSED");
    assert.equal(calls.length, 1);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a known pull request from another head repository is read again through the resolver", async () => {
  const path = await scope();
  try {
    const { github, calls } = mock({ headRepositoryId: "R_other" });
    await resolveRepository(path, "feature", github);
    calls.length = 0;
    assert.equal((await pullRequest(path, ref, github))?.id, ref.id);
    assert.equal(calls.length, 3);
    assert.match(calls[1]!.join(" "), /headRefName:\$branch/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("refuses a reply to, or a resolve of, a thread of another pull request before any mutation", async () => {
  const path = await scope();
  try {
    for (const write of [
      (github: Gh) => commentPullRequest(path, { pr: ref, body: "text", threadId: "PRRT_1" }, github),
      (github: Gh) => resolvePullRequestThread(path, { pr: ref, threadId: "PRRT_1", resolved: true }, github),
      (github: Gh) => resolvePullRequestThread(path, { pr: ref, threadId: "PRRT_1", resolved: false }, github),
    ]) {
      const other = mock({ threadPr: "PR_two" });
      await assert.rejects(write(other.github), /not on this pull request/);
      assert.equal(other.mutations.length, 0);
      const same = mock();
      await write(same.github);
      assert.ok(same.calls.some(call => call.join(" ").includes("PullRequestReviewThread{pullRequest") && call.includes("thread=PRRT_1")));
      assert.equal(same.mutations.length, 1);
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("refuses a re-run of a run that is not for the current head", async () => {
  const path = await scope();
  try {
    const stale = mock({ runSha: "b".repeat(40) });
    await assert.rejects(rerunPullRequestChecks(path, { pr: ref, runId: 123 }, stale.github), /not for the current head/);
    assert.ok(stale.calls.some(call => call[0] === "api" && call[1] === "repos/base/repo/actions/runs/123"));
    assert.ok(!stale.calls.some(call => call[0] === "run"));
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("Rebase rejects dirty state, existing Git operations and stale PR heads before fetching", async () => {
  const path = await scope();
  try {
    await writeFile(join(path, "dirty"), "work");
    await assert.rejects(changePullRequest(path, "rebase", actionInput, mock().github), /uncommitted/);
    await rm(join(path, "dirty"));
    await mkdir(join(path, ".git/rebase-merge"));
    await assert.rejects(changePullRequest(path, "rebase", actionInput, mock().github), /Finish or abort/);
    await assert.rejects(pullBranch(path, "feature"), /Finish or abort/);
    await rm(join(path, ".git/rebase-merge"), { recursive: true });
    for (const options of [{ headOid: "b".repeat(40) }, { baseBranch: "other" }, { state: "CLOSED" }]) await assert.rejects(changePullRequest(path, "rebase", actionInput, mock(options).github), /changed/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

for (const later of [{ headRefOid: "b".repeat(40) }, { baseRefName: "other" }, { id: "PR_two" }]) test(`refuses a rebase when the pull request changes during the fetch: ${Object.keys(later)[0]}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pr-rebase-"));
  try {
    const remote = repository(root, "remote", ["feature"]);
    const path = join(root, "local");
    git(root, "clone", "--quiet", remote, path);
    git(path, "switch", "feature");
    git(path, "remote", "set-url", "origin", "git@github.com:fork/repo.git");
    git(path, "config", `url.${remote}.insteadOf`, "https://github.com/base/repo.git");
    await writeFile(join(remote, "README.md"), "base change\n");
    git(remote, "commit", "--quiet", "-am", "base change");
    const before = git(path, "rev-parse", "HEAD").trim();
    await assert.rejects(changePullRequest(path, "rebase", actionInput, mock({ later }).github), /changed/);
    assert.equal(git(path, "rev-parse", "HEAD").trim(), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const conflict of [false, true]) test(`rebases only the current branch without push; conflicts=${conflict}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pr-rebase-"));
  try {
    const remote = repository(root, "remote", ["feature"]);
    const path = join(root, "local");
    git(root, "clone", "--quiet", remote, path);
    git(path, "config", "user.name", "Test");
    git(path, "config", "user.email", "test@example.com");
    git(path, "switch", "feature");
    git(path, "remote", "set-url", "origin", "git@github.com:fork/repo.git");
    git(path, "config", `url.${remote}.insteadOf`, "https://github.com/base/repo.git");
    await writeFile(join(path, conflict ? "README.md" : "feature.txt"), "feature change\n");
    git(path, "add", ".");
    git(path, "commit", "--quiet", "-m", "feature change");
    const before = git(path, "rev-parse", "HEAD").trim();
    git(path, "branch", "stack-other");
    git(path, "config", "rebase.updateRefs", "true");
    await writeFile(join(remote, "README.md"), "base change\n");
    git(remote, "commit", "--quiet", "-am", "base change");
    const base = git(remote, "rev-parse", "main").trim();
    if (conflict) {
      await assert.rejects(changePullRequest(path, "rebase", actionInput, mock().github), /Rebase aborted/);
      assert.equal(git(path, "rev-parse", "HEAD").trim(), before);
    } else {
      await changePullRequest(path, "rebase", actionInput, mock().github);
      assert.equal(git(path, "rev-parse", "HEAD^").trim(), base);
      assert.notEqual(git(path, "rev-parse", "HEAD").trim(), before);
    }
    assert.equal(git(path, "rev-parse", "stack-other").trim(), before);
    assert.equal(git(path, "branch", "--show-current").trim(), "feature");
    assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(git(remote, "rev-parse", "feature").trim(), git(path, "rev-parse", "origin/feature").trim());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pull fast-forwards, refuses divergence, dirty trees, detached and stale branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pull-"));
  try {
    const remote = repository(root, "remote");
    const path = join(root, "local");
    git(root, "clone", "--quiet", remote, path);
    await writeFile(join(remote, "incoming.txt"), "incoming change\n");
    git(remote, "add", ".");
    git(remote, "commit", "--quiet", "-m", "remote change");
    git(path, "config", "branch.main.mergeOptions", "--squash");
    await pullBranch(path, "main");
    assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(git(path, "rev-parse", "HEAD"), git(remote, "rev-parse", "HEAD"));
    await assert.rejects(pullBranch(path, "stale"), /changed/);
    await writeFile(join(path, "dirty"), "dirty");
    await assert.rejects(pullBranch(path, "main"), /uncommitted/);
    await rm(join(path, "dirty"));
    git(path, "commit", "--quiet", "--allow-empty", "-m", "local change");
    git(remote, "commit", "--quiet", "--allow-empty", "-m", "diverge");
    const before = git(path, "rev-parse", "HEAD");
    await assert.rejects(pullBranch(path, "main"), /fast-forward/i);
    assert.equal(git(path, "rev-parse", "HEAD"), before);
    git(path, "checkout", "--detach");
    await assert.rejects(pullBranch(path, "main"), /changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PR actions and Pull share the Scope operation safeguards", async () => {
  const path = await scope();
  const host = new SessionHost();
  const backend = new FakeBackend();
  host.registerBackend(backend);
  try {
    const sessionId = await host.create({ scope: path });
    const commands = [{ type: "pull_branch" as const, sessionId, branch: "feature" }, ...(["rebase", "merge"] as const).map(action => ({ type: "change_pull_request" as const, sessionId, action, input: actionInput }))];
    await host.send(sessionId, "work", "now");
    for (const command of commands) await assert.rejects(host.execute(command), /occupied/);
    const child = backend.latest.beginSubagent("worker", "work");
    backend.latest.completeTurn();
    for (const command of commands) await assert.rejects(host.execute(command), /Subagent or Background Call/);
    child.finish();
    const call = backend.latest.backgroundCall();
    for (const command of commands) await assert.rejects(host.execute(command), /Subagent or Background Call/);
    call.settle();
  } finally { await host.shutdown(); await rm(path, { recursive: true, force: true }); }
});

test("a Project target reads a pull request by number, without the branch, and refuses a changed one", async () => {
  const path = await scope();
  try {
    const { github, calls, mutations } = mock();
    assert.equal((await projectPullRequest(path, 1, github))?.id, ref.id);
    assert.equal(await projectPullRequest(path, 2, github), null);
    calls.length = 0;
    await commentPullRequest(path, { pr: ref, body: "text" }, github, projectTarget);
    assert.ok(calls.every(call => !call.join(" ").includes("headRefName:$branch")));
    assert.equal(mutations.length, 1);
    await assert.rejects(commentPullRequest(path, { pr: { ...ref, id: "PR_other" }, body: "text" }, github, projectTarget), /has changed/);
    await assert.rejects(commentPullRequest(path, { pr: { ...ref, repo: "other/repo" }, body: "text" }, github, projectTarget), /has changed/);
    await assert.rejects(changePullRequest(path, "rebase", actionInput, github, projectTarget), /Agent Session/);
    await changePullRequest(path, "merge", { ...actionInput, method: "SQUASH" }, github, projectTarget);
    assert.match(mutations.at(-1)!.join(" "), /mergePullRequest/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("lists open pull requests of the base repository, review requests first", async () => {
  const path = await scope();
  try {
    const node = (number: number, login?: string) => ({ id: `PR_${number}`, number, title: `T${number}`, isDraft: false, updatedAt: "2025-01-01", author: { login: "user" }, reviewRequests: { nodes: login ? [{ requestedReviewer: { login } }, { requestedReviewer: {} }] : [] } });
    const list = await listPullRequests(path, mock({ list: [node(1), node(2, "me"), node(3, "other")] }).github);
    assert.deepEqual(list.map(item => [item.number, item.reviewRequested, item.repo]), [[2, true, "base/repo"], [1, false, "base/repo"], [3, false, "base/repo"]]);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a Review is one mutation, and needs a comment unless it approves", async () => {
  const path = await scope();
  try {
    const { github, mutations } = mock();
    await submitReview(path, { pr: ref, event: "APPROVE", body: "" }, github, projectTarget);
    assert.match(mutations[0]!.join(" "), /addPullRequestReview/);
    assert.ok(mutations[0]!.includes("event=APPROVE"));
    await assert.rejects(submitReview(path, { pr: ref, event: "REQUEST_CHANGES", body: " " }, github, projectTarget), /Enter a comment/);
    await assert.rejects(submitReview(path, { pr: ref, event: "DISMISS" as "COMMENT", body: "x" }, github, projectTarget), /Invalid review/);
    assert.equal(mutations.length, 1);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a pull request range fetches missing commits once and writes no refs", async () => {
  const parent = await mkdtemp(join(tmpdir(), "flow-pr-range-"));
  try {
    const server = repository(parent, "server");
    git(server, "switch", "--quiet", "-c", "feature");
    await writeFile(join(server, "a.ts"), "a\n");
    git(server, "add", ".");
    git(server, "commit", "--quiet", "-m", "change");
    const head = git(server, "rev-parse", "HEAD").trim();
    const base = git(server, "rev-parse", "main").trim();
    git(server, "update-ref", "refs/pull/1/head", head);
    const path = await scope();
    git(path, "config", `url.${server}.insteadOf`, "https://github.com/base/repo.git");
    const refs = git(path, "for-each-ref");
    const { github } = mock({ headOid: head, baseOid: base });
    assert.deepEqual(await pullRequestRange(path, ref, github).then(range => [range.base, range.head]), [base, head]);
    assert.equal(git(path, "for-each-ref"), refs);
    git(server, "update-ref", "-d", "refs/pull/1/head");
    assert.deepEqual(await pullRequestRange(path, ref, github).then(range => [range.base, range.head]), [base, head]);
    git(server, "update-ref", "refs/pull/1/head", head);
    await assert.rejects(pullRequestRange(path, ref, mock({ headOid: "c".repeat(40), baseOid: base }).github), /has changed/);
    await rm(path, { recursive: true, force: true });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("drops a branch only while it still points at the fetched commit", async () => {
  const parent = await mkdtemp(join(tmpdir(), "flow-pr-drop-"));
  try {
    const path = repository(parent, "repo", ["feature"]);
    const oid = git(path, "rev-parse", "feature").trim();
    git(path, "branch", "moved");
    git(path, "update-ref", "refs/heads/moved", git(path, "commit-tree", "HEAD^{tree}", "-p", oid, "-m", "local").trim());
    await dropUnchangedBranch(path, "moved", oid);
    await dropUnchangedBranch(path, "feature", oid);
    assert.deepEqual(git(path, "branch", "--format=%(refname:short)").trim().split("\n"), ["main", "moved"]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

const ref = { repo: "base/repo", number: 1, id: "PR_one" };
const actionInput = { pr: ref, headOid: "a".repeat(40), baseBranch: "main" };
const open = { ...ref, url: "https://github.com/base/repo/pull/1", title: "Change", baseRefName: "main", headRefOid: "a".repeat(40), state: "OPEN", isDraft: false, reviewDecision: null, updatedAt: "2025-01-01", closedAt: null, headRepository: { id: "R_source" }, commits: { nodes: [] }, reviewThreads: { nodes: [] } };
const repositoryView = (args: string[]) => JSON.stringify(args[2] === "base/repo"
  ? { id: "R_base", defaultBranchRef: { name: "main" }, isFork: false }
  : { id: "R_source", defaultBranchRef: { name: "main" }, isFork: true, parent: { name: "repo", owner: { login: "base" } } });
const entry = { id: "C_one", author: { login: "user" }, body: "![image](url)", url: "url", createdAt: "2025-01-01", diffHunk: "@@ -1 +1 @@" };
type Options = { list?: object[]; baseOid?: string; candidates?: readonly object[]; fail?: boolean; locked?: boolean; archived?: boolean; permission?: string; state?: string; methods?: MergeMethod[]; headOid?: string; baseBranch?: string; draft?: boolean; elsewhere?: string; threads?: number; checks?: number; checkNodes?: object[]; more?: "comments" | "reviews" | "threads" | "thread" | "checks" | "nested"; threadPr?: string; runSha?: string; log?: string | Error; later?: object; headRepositoryId?: string };
function mock(options: Options = {}) {
  const mutations: string[][] = [];
  const calls: string[][] = [];
  const connection = (nodes: unknown[], more = false) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? "next" : null } });
  const threads = Array.from({ length: options.threads ?? 1 }, (_, index) => ({ id: `PRRT_${index}`, path: "a.ts", line: index + 1, isOutdated: false, isResolved: index > 0, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, comments: connection([entry], options.more === "thread" && index === 1) }));
  const checks = options.checkNodes ?? Array.from({ length: options.checks ?? 1 }, (_, index) => ({ name: `check ${index}`, status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: `https://github.com/base/repo/actions/runs/9/job/${index}` }));
  const details = {
    ...ref, url: open.url, title: "Change", body: entry.body, state: options.state ?? "OPEN", isDraft: options.draft ?? false, reviewDecision: null, updatedAt: "2025-01-02", author: { login: "user" },
    headRefName: "feature", headRefOid: "a".repeat(40), headRepository: { id: options.headRepositoryId ?? "R_source", nameWithOwner: "fork/repo" }, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", locked: options.locked ?? false,
    repository: { isArchived: options.archived ?? false, viewerPermission: options.permission ?? "READ", mergeCommitAllowed: options.methods?.includes("MERGE") ?? false, squashMergeAllowed: options.methods?.includes("SQUASH") ?? false, rebaseMergeAllowed: options.methods?.includes("REBASE") ?? false },
    comments: connection([entry], options.more === "comments"),
    reviews: connection([{ ...entry, state: "APPROVED" }], options.more === "reviews"),
    reviewThreads: connection(threads, options.more === "threads" || options.more === "nested"),
    commits: { nodes: [{ commit: { statusCheckRollup: { id: "rollup", contexts: connection(checks, options.more === "checks") } } }] },
  };
  let resolved = 0;
  const github: Gh = async (_, args) => {
    calls.push(args);
    if (args[0] === "auth" || args[0] === "run") return "";
    if (args[0] === "api" && args[1]?.endsWith("/logs")) {
      if (options.log instanceof Error) throw options.log;
      return options.log ?? "";
    }
    if (args[0] === "api" && args[1]?.startsWith("repos/")) return JSON.stringify({ head_sha: options.runSha ?? "a".repeat(40) });
    if (args[0] === "repo") return repositoryView(args);
    const query = args.find(value => value.startsWith("query="))!;
    let data: unknown;
    if (query.includes("mutation(")) {
      mutations.push(args);
      if (options.fail) return JSON.stringify({ errors: [{ message: "denied" }] });
      data = { result: {} };
    } else if (query.includes("pullRequest(number:$number)")) data = { repository: { pullRequest: args.includes("number=1") ? { ...open, headRefName: "feature", baseRefOid: options.baseOid ?? "b".repeat(40), headRefOid: options.headOid ?? open.headRefOid } : null } };
    else if (query.includes("pullRequests(states:OPEN")) data = { viewer: { login: "me" }, repository: { pullRequests: { nodes: options.list ?? [] } } };
    else if (query.includes("headRefName:$branch")) data = { repository: { pullRequests: { nodes: options.candidates ?? [{ ...open, state: options.state ?? "OPEN", isDraft: options.draft ?? false, headRefOid: options.headOid ?? open.headRefOid, baseRefName: options.baseBranch ?? "main", ...(resolved++ && options.later) }] } } };
    else if (query.includes("PullRequestReviewThread{pullRequest")) data = { node: { pullRequest: { id: options.threadPr ?? ref.id } } };
    else if (query.includes("after:$cursor")) {
      const field = /\{(\w+)\(first:100,after/.exec(query)![1]!;
      data = { node: { [field]: connection([field === "reviewThreads" ? { ...threads[0], id: "PRRT_more", comments: connection([entry], options.more === "nested") } : field === "contexts" ? checks[0] : entry]) } };
    } else data = { node: options.elsewhere && args.includes(`id=${options.elsewhere}`) ? { ...details, id: options.elsewhere, headRefName: "elsewhere" } : details };
    return JSON.stringify({ data });
  };
  return { github, mutations, calls };
}
async function scope() {
  const path = await mkdtemp(join(tmpdir(), "flow-pr-"));
  for (const args of [["init", "-b", "feature"], ["remote", "add", "origin", "git@github.com:fork/repo.git"], ["remote", "add", "upstream", "https://github.com/base/repo.git"]]) execFileSync("git", args, { cwd: path });
  return path;
}
