import { api, connection, gh, type Gh } from "./github.ts";
import { resolvePullRequest, resolveRepository } from "./repository.ts";
import { cleanStack } from "./stack.ts";
import type { MergeMethod, PullRequestActionInput } from "../protocol/pull-request.ts";
import { head, isRepository, run, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { PullRequestComment, PullRequestDetails, PullRequestCommentInput, PullRequestThreadInput, PullRequestRef, PullRequestThread } from "../protocol/pull-request.ts";

const commentFields = "id author { login } body url createdAt";
type Comment = Omit<PullRequestComment, "author"> & { author: { login: string } | null };
const comment = (value: Comment): PullRequestComment => ({ ...value, author: value.author?.login ?? "[deleted]" });

export async function pullRequest(scope: string, github: Gh = gh): Promise<PullRequestDetails | null> {
  if (!isRepository(scope)) return null;
  const branch = await head(scope);
  if (!branch.ok) throw new Error(branch.failure.message);
  if (branch.value.detached) return null;
  const resolved = await resolvePullRequest(scope, await resolveRepository(scope, branch.value.name, github), branch.value.name, github);
  if (!resolved) return null;
  const ref: PullRequestRef = { repo: resolved.repo, number: resolved.number, id: resolved.id };
  const data = await api<{ node: Omit<PullRequestDetails, "author" | "viewerCanComment" | "headRepository"> & { author: { login: string } | null; headRepository: { nameWithOwner: string } | null; locked: boolean; repository: { isArchived: boolean; viewerPermission: string | null; mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean }; commits: { nodes: { commit: { statusCheckRollup: { id: string } | null } }[] } } }>(scope, github,
    `query($id:ID!){node(id:$id){... on PullRequest{id number url title body state isDraft reviewDecision author{login} headRefName headRefOid headRepository{nameWithOwner} baseRefName createdAt updatedAt mergeable mergeStateStatus locked repository{isArchived viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed} commits(last:1){nodes{commit{statusCheckRollup{id}}}}}}}`, ref);
  const { commits, author, headRepository, locked, repository, ...details } = data.node;
  const viewerCanComment = !repository.isArchived && (!locked || ["ADMIN", "MAINTAIN", "WRITE"].includes(repository.viewerPermission ?? ""));
  const comments = (await connection<Comment>(scope, github, ref.id, "PullRequest", "comments", commentFields)).map(comment);
  const reviews = (await connection<Comment & { state: string }>(scope, github, ref.id, "PullRequest", "reviews", `${commentFields} state`)).map(value => ({ ...comment(value), state: value.state }));
  const rawThreads = await connection<Omit<PullRequestThread, "comments" | "diffHunk">>(scope, github, ref.id, "PullRequest", "reviewThreads", "id path line isOutdated isResolved viewerCanReply viewerCanResolve viewerCanUnresolve");
  const threads: PullRequestThread[] = [];
  for (const thread of rawThreads) {
    const entries = await connection<Comment & { diffHunk: string }>(scope, github, thread.id, "PullRequestReviewThread", "comments", `${commentFields} diffHunk`);
    threads.push({ ...thread, diffHunk: entries[0]?.diffHunk ?? "", comments: entries.map(comment) });
  }
  const rollup = commits.nodes[0]?.commit.statusCheckRollup;
  const statusCheckRollup = rollup ? await connection<PullRequestDetails["statusCheckRollup"][number]>(scope, github, rollup.id, "StatusCheckRollup", "contexts", "... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }") : [];
  const mergeMethods: MergeMethod[] = [];
  if (!repository.isArchived && ["ADMIN", "MAINTAIN", "WRITE"].includes(repository.viewerPermission ?? "")) {
    if (repository.mergeCommitAllowed) mergeMethods.push("MERGE");
    if (repository.squashMergeAllowed) mergeMethods.push("SQUASH");
    if (repository.rebaseMergeAllowed) mergeMethods.push("REBASE");
  }
  return { ...details, ...ref, mergeMethods, ...(headRepository ? { headRepository: headRepository.nameWithOwner } : {}), author: author?.login ?? "[deleted]", viewerCanComment, comments, reviews, threads, statusCheckRollup };
}

async function git(scope: string, args: string[]): Promise<string> {
  const result = await run(scope, args, GIT_WRITE_TIMEOUT_MS);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value.trim();
}

export async function pullBranch(scope: string, branch: string): Promise<void> {
  await cleanStack(scope);
  const selected = await head(scope);
  if (!selected.ok || selected.value.detached || selected.value.name !== branch) throw new Error("The branch has changed. Refresh Git status before pulling.");
  await git(scope, ["pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-squash"]);
}

export async function changePullRequest(scope: string, action: "rebase" | "merge", input: PullRequestActionInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (action !== "rebase" && action !== "merge") throw new Error("Invalid pull request action.");
  if (!/^[0-9a-f]{40,64}$/.test(input.headOid) || typeof input.baseBranch !== "string") throw new Error("Invalid pull request action.");
  const pr = await current(scope, input.pr, github);
  if (pr.state !== "OPEN" || pr.headRefOid !== input.headOid || pr.baseRefName !== input.baseBranch) throw new Error("The pull request has changed. Reload it before continuing.");
  if (action === "merge") {
    if (pr.isDraft || !input.method || !pr.mergeMethods?.includes(input.method)) throw new Error("This merge method is not permitted for this pull request.");
    await api(scope, github, "mutation($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}){pullRequest{id state}}}", { id: pr.id, head: input.headOid, method: input.method });
    return;
  }
  await cleanStack(scope);
  await git(scope, ["check-ref-format", `refs/heads/${pr.baseRefName}`]);
  const before = await git(scope, ["rev-parse", "HEAD"]);
  let baseUrl = `https://github.com/${pr.repo}.git`;
  for (const remote of (await git(scope, ["remote"])).split("\n").filter(Boolean)) {
    const url = await git(scope, ["remote", "get-url", remote]);
    const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
    if (repo?.toLowerCase() === pr.repo.toLowerCase()) { baseUrl = url; break; }
  }
  await git(scope, ["fetch", "--no-tags", baseUrl, `refs/heads/${pr.baseRefName}`]);
  const base = await git(scope, ["rev-parse", "FETCH_HEAD"]);
  const latest = await current(scope, input.pr, github);
  const branch = await head(scope);
  if (latest.state !== "OPEN" || latest.headRefOid !== input.headOid || latest.baseRefName !== input.baseBranch || !branch.ok || branch.value.detached || branch.value.name !== pr.headRefName || await git(scope, ["rev-parse", "HEAD"]) !== before) throw new Error("The branch or pull request has changed. Reload it before rebasing.");
  await cleanStack(scope);
  const rebased = await run(scope, ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false", "rebase", base], GIT_WRITE_TIMEOUT_MS);
  if (!rebased.ok) {
    const aborted = await run(scope, ["rebase", "--abort"], GIT_WRITE_TIMEOUT_MS);
    throw new Error(`${rebased.failure.message}\n${aborted.ok ? "Rebase aborted. Local changes were not pushed." : `Rebase did not complete. Check Git status in the Shell; if a rebase remains, run git rebase --abort. ${aborted.failure.message}`}`);
  }
}

function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_+/=-]+$/.test(value) && value.length <= 256; }
function validate(ref: PullRequestRef | undefined): void {
  if (!ref || typeof ref.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repo) || !Number.isSafeInteger(ref.number) || ref.number < 1 || !validId(ref.id)) throw new Error("Invalid pull request reference.");
}
async function current(scope: string, ref: PullRequestRef, github: Gh): Promise<PullRequestDetails> {
  const pr = await pullRequest(scope, github);
  if (!pr || pr.id !== ref.id || pr.number !== ref.number || pr.repo !== ref.repo) throw new Error("The branch's pull request has changed. Reload it before continuing.");
  return pr;
}
export async function commentPullRequest(scope: string, input: PullRequestCommentInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (typeof input.body !== "string" || !input.body.trim() || (input.threadId !== undefined && !validId(input.threadId))) throw new Error("Invalid comment input.");
  const pr = await current(scope, input.pr, github);
  if (input.threadId !== undefined) {
    const thread = pr.threads.find(value => value.id === input.threadId);
    if (!thread?.viewerCanReply) throw new Error("Cannot reply to this thread.");
    await api(scope, github, "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}", { id: thread.id, body: input.body });
  } else {
    if (!pr.viewerCanComment) throw new Error("Cannot comment on this pull request.");
    await api(scope, github, "mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{id}}}}", { id: pr.id, body: input.body });
  }
}
export async function resolvePullRequestThread(scope: string, input: PullRequestThreadInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (!validId(input.threadId) || typeof input.resolved !== "boolean") throw new Error("Invalid thread input.");
  const pr = await current(scope, input.pr, github);
  const thread = pr.threads.find(value => value.id === input.threadId);
  if (!thread || !(input.resolved ? thread.viewerCanResolve : thread.viewerCanUnresolve)) throw new Error("Cannot change this thread's resolved state.");
  const operation = input.resolved ? "resolveReviewThread" : "unresolveReviewThread";
  await api(scope, github, `mutation($id:ID!){${operation}(input:{threadId:$id}){thread{id}}}`, { id: thread.id });
}
