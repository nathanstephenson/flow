import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { git, repository } from "./git-fixture.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { MergeMethod } from "../src/protocol/pull-request.ts";
import { pullRequest, commentPullRequest, resolvePullRequestThread, changePullRequest, pullBranch } from "../src/daemon/pull-request.ts";
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

const actionInput = { pr: { repo: "base/repo", number: 1, id: "PR_one" }, headOid: "a".repeat(40), baseBranch: "main" };

for (const method of ["MERGE", "SQUASH", "REBASE"] as const) test(`merges with permitted ${method} and an expected head`, async () => {
  const path = await scope();
  try {
    const { github, mutations } = mock({ permission: "WRITE", methods: [method] });
    assert.deepEqual((await pullRequest(path, github))?.mergeMethods, [method]);
    await changePullRequest(path, "merge", { ...actionInput, method }, github);
    assert.equal(mutations.length, 1);
    assert.match(mutations[0]!.join(" "), /expectedHeadOid:\$head/);
    assert.ok(mutations[0]!.includes(`head=${actionInput.headOid}`));
    assert.ok(mutations[0]!.includes(`method=${method}`));
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("rejects changed PRs, invalid methods, drafts and denied merges without mutations", async () => {
  const path = await scope();
  try {
    for (const options of [{ state: "CLOSED" }, { state: "MERGED" }, { headOid: "b".repeat(40) }, { baseBranch: "other" }, { draft: true }, { denied: true }, { permission: "READ" }, { methods: [] }, { candidates: [] }]) {
      const { github, mutations } = mock({ permission: "WRITE", methods: ["MERGE"], ...options });
      await assert.rejects(changePullRequest(path, "merge", { ...actionInput, method: "MERGE" }, github));
      assert.equal(mutations.length, 0);
    }
    const failure = mock({ permission: "WRITE", methods: ["MERGE"], fail: true });
    await assert.rejects(changePullRequest(path, "merge", { ...actionInput, method: "MERGE" }, failure.github), /denied/);
    assert.equal(failure.mutations.length, 1);
    await assert.rejects(changePullRequest(path, "merge", { ...actionInput, pr: { ...actionInput.pr, id: "stale" }, method: "MERGE" }, mock().github), /changed/);
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
    await assert.rejects(changePullRequest(path, "rebase", actionInput, mock({ headOid: "b".repeat(40) }).github), /changed/);
  } finally { await rm(path, { recursive: true, force: true }); }
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
    git(remote, "commit", "--quiet", "--allow-empty", "-m", "remote change");
    await pullBranch(path, "main");
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

const ref = { repo: "base/repo", number: 1, id: "PR_one" };
const closed = { ...ref, state: "CLOSED", updatedAt: "2026-01-02", closedAt: "2026-01-02" as string | null, headRepository: { id: "R_source" } };
const open = { ...closed, state: "OPEN", updatedAt: "2025-01-01", closedAt: null };
const thread = { id: "PRRT_one", path: "a.ts", line: 2, isOutdated: false, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true };
const entry = { id: "C_one", author: { login: "user" }, body: "![image](url)", url: "url", createdAt: "2025-01-01", diffHunk: "@@ -1 +1 @@" };
function mock(options: { candidates?: typeof closed[]; denied?: boolean; fail?: boolean; paginate?: boolean; locked?: boolean; permission?: string; state?: string; methods?: MergeMethod[]; headOid?: string; baseBranch?: string; draft?: boolean } = {}) {
  const mutations: string[][] = [];
  const calls: string[][] = [];
  const github: Gh = async (_, args) => {
    calls.push(args);
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: ref.repo, id: "R_source" });
    const query = args.find(value => value.startsWith("query="))!;
    const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: !!options.paginate && !args.includes("cursor=next"), endCursor: "next" } });
    let data: unknown;
    if (query.includes("mutation(")) {
      mutations.push(args);
      if (options.fail) return JSON.stringify({ errors: [{ message: "denied" }] });
      data = { result: {} };
    } else if (query.includes("headRefName:$branch")) data = { repository: { pullRequests: connection(options.candidates ?? [open]) } };
    else if (query.includes("commits(last:1)")) data = { node: { ...ref, state: options.state ?? "OPEN", isDraft: options.draft ?? false, headRefName: "feature", headRefOid: options.headOid ?? "a".repeat(40), baseRefName: options.baseBranch ?? "main", body: "![image](url)", author: { login: "user" }, headRepository: { nameWithOwner: "fork/repo" }, locked: options.locked ?? false, repository: { isArchived: options.denied ?? false, viewerPermission: options.permission ?? "READ", mergeCommitAllowed: options.methods?.includes("MERGE"), squashMergeAllowed: options.methods?.includes("SQUASH"), rebaseMergeAllowed: options.methods?.includes("REBASE") }, commits: { nodes: [{ commit: { statusCheckRollup: { id: "rollup" } } }] } } };
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
    const { github } = mock({ candidates: [{ ...closed, id: "foreign", headRepository: { id: "R_other" } }, closed, { ...open, id: "selected" }] });
    assert.equal((await pullRequest(path, github))?.id, "selected");
    const latest = mock({ candidates: [{ ...closed, id: "older", closedAt: "2024-01-01", updatedAt: "2026-02-01" }, { ...closed, state: "MERGED", id: "latest" }] });
    assert.equal((await pullRequest(path, latest.github))?.id, "latest");
    assert.equal(await pullRequest(path, mock({ candidates: [] }).github), null);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("matches repository IDs after a rename and handles comment locks", async () => {
  const path = await scope();
  try {
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:old-owner/old-name.git"], { cwd: path });
    const loaded = await pullRequest(path, mock().github);
    assert.equal(loaded?.id, ref.id);
    assert.equal(loaded?.viewerCanComment, true);
    assert.equal((await pullRequest(path, mock({ locked: true }).github))?.viewerCanComment, false);
    assert.equal((await pullRequest(path, mock({ locked: true, permission: "WRITE" }).github))?.viewerCanComment, true);
    assert.equal((await pullRequest(path, mock({ denied: true, permission: "ADMIN" }).github))?.viewerCanComment, false);
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
    assert.equal(result?.headRepository, "fork/repo");
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
    await assert.rejects(pullRequest(path, async (_, args) => args[0] === "repo" ? JSON.stringify({ nameWithOwner: ref.repo, id: "R_source" }) : JSON.stringify({ errors: [{ message: "API failure" }] })), /API failure/);
  } finally { await rm(path, { recursive: true, force: true }); }
});
