import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pullRequest, commentPullRequest, resolvePullRequestThread } from "../src/daemon/pull-request.ts";
import { SessionHost } from "../src/daemon/host.ts";
import type { Gh } from "../src/daemon/publish.ts";

test("Session Host routes all PR commands through Agent Session lookup", async () => {
  const host = new SessionHost();
  for (const command of [
    { type: "pull_request" as const, sessionId: "missing" },
    { type: "comment_pull_request" as const, sessionId: "missing", input: { pr: ref, body: "text" } },
    { type: "resolve_pull_request_thread" as const, sessionId: "missing", input: { pr: ref, threadId: "thread", resolved: true } },
  ]) await assert.rejects(host.execute(command), /session/i);
});

const ref = { repo: "base/repo", number: 1, id: "PR_one" };
const closed = { ...ref, state: "CLOSED", updatedAt: "2026-01-02", headRepository: { nameWithOwner: "fork/repo" } };
const open = { ...closed, state: "OPEN", updatedAt: "2025-01-01" };
const thread = { id: "PRRT_one", path: "a.ts", line: 2, isOutdated: false, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true };
const entry = { id: "C_one", author: { login: "user" }, body: "![image](url)", url: "url", createdAt: "2025-01-01", diffHunk: "@@ -1 +1 @@" };
function mock(options: { candidates?: typeof closed[]; denied?: boolean; fail?: boolean; paginate?: boolean } = {}) {
  const mutations: string[][] = [];
  const calls: string[][] = [];
  const github: Gh = async (_, args) => {
    calls.push(args);
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: ref.repo });
    const query = args.find(value => value.startsWith("query="))!;
    const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: !!options.paginate && !args.includes("cursor=next"), endCursor: "next" } });
    let data: unknown;
    if (query.includes("mutation(")) {
      mutations.push(args);
      if (options.fail) return JSON.stringify({ errors: [{ message: "denied" }] });
      data = { result: {} };
    } else if (query.includes("headRefName:$branch")) data = { repository: { pullRequests: connection(options.candidates ?? [open]) } };
    else if (query.includes("commits(last:1)")) data = { node: { ...ref, body: "![image](url)", author: { login: "user" }, viewerCanComment: !options.denied, commits: { nodes: [{ commit: { statusCheckRollup: { id: "rollup" } } }] } } };
    else if (query.includes("reviewThreads(")) data = { node: { reviewThreads: connection([{ ...thread, viewerCanReply: !options.denied, viewerCanResolve: !options.denied, viewerCanUnresolve: !options.denied }]) } };
    else if (query.includes("reviews(")) data = { node: { reviews: connection([{ ...entry, state: "APPROVED" }]) } };
    else if (query.includes("contexts(")) data = { node: { contexts: connection([{ name: "test", detailsUrl: "https://example.com/check" }]) } };
    else data = { node: { comments: connection([entry]) } };
    return JSON.stringify({ data });
  };
  return { github, mutations, calls };
}
async function scope() {
  const path = await mkdtemp(join(tmpdir(), "flow-pr-"));
  for (const args of [["init", "-b", "feature"], ["remote", "add", "origin", "git@github.com:fork/repo.git"], ["remote", "add", "upstream", "https://github.com/base/repo.git"]]) execFileSync("git", args, { cwd: path });
  return path;
}

test("reads fork with multiple remotes; prefers open and excludes foreign sources", async () => {
  const path = await scope();
  try {
    const { github } = mock({ candidates: [{ ...closed, id: "foreign", headRepository: { nameWithOwner: "other/repo" } }, closed, { ...open, id: "selected" }] });
    assert.equal((await pullRequest(path, github))?.id, "selected");
    const latest = mock({ candidates: [{ ...closed, id: "older", updatedAt: "2024-01-01" }, { ...closed, id: "latest" }] });
    assert.equal((await pullRequest(path, latest.github))?.id, "latest");
    assert.equal(await pullRequest(path, mock({ candidates: [] }).github), null);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("loads all connection pages and preserves Markdown, diff context and CI links", async () => {
  const path = await scope();
  try {
    const result = await pullRequest(path, mock({ paginate: true }).github);
    assert.equal(result?.comments.length, 2);
    assert.equal(result?.reviews.length, 2);
    assert.equal(result?.threads.length, 2);
    assert.equal(result?.threads[0]?.comments.length, 2);
    assert.equal(result?.statusCheckRollup.length, 2);
    assert.equal(result?.body, entry.body);
    assert.equal(result?.threads[0]?.diffHunk, entry.diffHunk);
    assert.equal(result?.statusCheckRollup[0]?.detailsUrl, "https://example.com/check");
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("comments, replies, resolve and unresolve use variables without mutation retries", async () => {
  const path = await scope();
  try {
    const { github, mutations } = mock();
    const body = 'hello "quoted"\n![image](url)';
    await commentPullRequest(path, { pr: ref, body }, github);
    await commentPullRequest(path, { pr: ref, body, threadId: thread.id }, github);
    await resolvePullRequestThread(path, { pr: ref, threadId: thread.id, resolved: true }, github);
    await resolvePullRequestThread(path, { pr: ref, threadId: thread.id, resolved: false }, github);
    assert.equal(mutations.length, 4);
    assert.ok(mutations[0]!.includes(`body=${body}`));
    assert.match(mutations[1]!.join(" "), /addPullRequestReviewThreadReply/);
    assert.match(mutations[2]!.join(" "), /resolveReviewThread/);
    assert.match(mutations[3]!.join(" "), /unresolveReviewThread/);
    const failure = mock({ fail: true });
    await assert.rejects(commentPullRequest(path, { pr: ref, body }, failure.github), /denied/);
    assert.equal(failure.mutations.length, 1);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("rejects stale ownership, missing threads, permissions and malformed inputs", async () => {
  const path = await scope();
  try {
    const normal = mock();
    for (const pr of [{ ...ref, id: "other" }, { ...ref, repo: "other/repo" }, { ...ref, number: 2 }]) await assert.rejects(commentPullRequest(path, { pr, body: "text" }, normal.github), /changed/);
    await assert.rejects(commentPullRequest(path, { pr: ref, body: " " }, normal.github), /Invalid/);
    await assert.rejects(commentPullRequest(path, { pr: ref, body: "text", threadId: "bad id" }, normal.github), /Invalid/);
    await assert.rejects(commentPullRequest(path, { pr: ref, body: "text", threadId: "other" }, normal.github), /Cannot reply/);
    const denied = mock({ denied: true });
    await assert.rejects(commentPullRequest(path, { pr: ref, body: "text" }, denied.github), /Cannot comment/);
    await assert.rejects(commentPullRequest(path, { pr: ref, body: "text", threadId: thread.id }, denied.github), /Cannot reply/);
    for (const resolved of [true, false]) await assert.rejects(resolvePullRequestThread(path, { pr: ref, threadId: thread.id, resolved }, denied.github), /Cannot change/);
    assert.equal(normal.mutations.length + denied.mutations.length, 0);
    await assert.rejects(pullRequest(path, async (_, args) => args[0] === "repo" ? JSON.stringify({ nameWithOwner: ref.repo }) : JSON.stringify({ errors: [{ message: "API failure" }] })), /API failure/);
  } finally { await rm(path, { recursive: true, force: true }); }
});
