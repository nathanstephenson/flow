import { api, connection, gh, page, type Connection, type Gh } from "./github.ts";
import { resolvePullRequest, resolveRepository, type ResolvedPullRequest } from "./repository.ts";
import { cleanStack } from "./stack.ts";
import { pushTarget, remoteHead } from "./push.ts";
import { localStack, stackParent } from "./stack-metadata.ts";
import type { PullRequestInput } from "../protocol/git.ts";
import { head, isRepository, run, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { MergeMethod, PullRequestActionInput, PullRequestCheck, PullRequestCheckLog, PullRequestComment, PullRequestCommentInput, PullRequestDetails, PullRequestDraftInput, PullRequestEditInput, PullRequestRef, PullRequestRerunInput, PullRequestThread, PullRequestThreadInput } from "../protocol/pull-request.ts";

const commentFields = "id author{login} body url createdAt";
const threadFields = "id path line isOutdated isResolved viewerCanReply viewerCanResolve viewerCanUnresolve";
const threadCommentFields = `${commentFields} diffHunk`;
const checkFields = "... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}";
const detailsQuery = `query($id:ID!){node(id:$id){... on PullRequest{id number url title body state isDraft reviewDecision updatedAt author{login} headRefName headRefOid headRepository{id nameWithOwner} baseRefName mergeable mergeStateStatus locked repository{isArchived viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed} comments(first:100){nodes{${commentFields}} ${page}} reviews(first:100){nodes{${commentFields} state} ${page}} reviewThreads(first:100){nodes{${threadFields} comments(first:100){nodes{${threadCommentFields}} ${page}}} ${page}} commits(last:1){nodes{commit{statusCheckRollup{id contexts(first:100){nodes{${checkFields}} ${page}}}}}}}}}`;
const writers = ["ADMIN", "MAINTAIN", "WRITE"];

type Comment = Omit<PullRequestComment, "author"> & { author: { login: string } | null };
type ThreadNode = Omit<PullRequestThread, "comments" | "diffHunk"> & { comments: Connection<Comment & { diffHunk: string }> };
type CheckNode = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string; detailsUrl?: string | null; targetUrl?: string | null };
type DetailsNode = Omit<PullRequestDetails, "repo" | "author" | "headRepository" | "viewerCanComment" | "mergeMethods" | "checks" | "comments" | "reviews" | "threads"> & {
  author: { login: string } | null;
  headRepository: { id: string; nameWithOwner: string } | null;
  locked: boolean;
  repository: { isArchived: boolean; viewerPermission: string | null; mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean };
  comments: Connection<Comment>;
  reviews: Connection<Comment & { state: string }>;
  reviewThreads: Connection<ThreadNode>;
  commits: { nodes: { commit: { statusCheckRollup: { id: string; contexts: Connection<CheckNode> } | null } }[] };
};

const comment = (value: Comment): PullRequestComment => ({ ...value, author: value.author?.login ?? "[deleted]" });

function check(node: CheckNode): PullRequestCheck {
  const url = node.detailsUrl || node.targetUrl || "";
  const ids = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url);
  return { name: node.name || node.context || "Check", status: node.conclusion || node.state || node.status || "UNKNOWN", url, ...(ids ? { runId: Number(ids[1]), jobId: Number(ids[2]) } : {}) };
}

async function details(scope: string, ref: Pick<PullRequestRef, "repo" | "id">, github: Gh): Promise<{ pr: PullRequestDetails; headRepositoryId: string | undefined } | undefined> {
  const { id } = ref;
  const { node } = await api<{ node: DetailsNode | null }>(scope, github, detailsQuery, { id });
  if (!node) return undefined;
  const { author, headRepository, locked, repository, comments, reviews, reviewThreads, commits, ...fields } = node;
  const threads: PullRequestThread[] = [];
  for (const { comments: entries, ...thread } of await connection(scope, github, reviewThreads, id, "PullRequest", "reviewThreads", `${threadFields} comments(first:100){nodes{${threadCommentFields}} ${page}}`)) {
    const all = await connection(scope, github, entries, thread.id, "PullRequestReviewThread", "comments", threadCommentFields);
    threads.push({ ...thread, diffHunk: all[0]?.diffHunk ?? "", comments: all.map(comment) });
  }
  const rollup = commits.nodes[0]?.commit.statusCheckRollup;
  const writer = !repository.isArchived && writers.includes(repository.viewerPermission ?? "");
  const mergeMethods: MergeMethod[] = !writer ? [] : [
    ...(repository.mergeCommitAllowed ? ["MERGE" as const] : []),
    ...(repository.squashMergeAllowed ? ["SQUASH" as const] : []),
    ...(repository.rebaseMergeAllowed ? ["REBASE" as const] : []),
  ];
  return { headRepositoryId: headRepository?.id, pr: {
    ...fields, repo: ref.repo, author: author?.login ?? "[deleted]", mergeMethods,
    ...(headRepository ? { headRepository: headRepository.nameWithOwner } : {}),
    viewerCanComment: !repository.isArchived && (!locked || writers.includes(repository.viewerPermission ?? "")),
    comments: (await connection(scope, github, comments, id, "PullRequest", "comments", commentFields)).map(comment),
    reviews: (await connection(scope, github, reviews, id, "PullRequest", "reviews", `${commentFields} state`)).map(value => ({ ...comment(value), state: value.state })),
    threads,
    checks: rollup ? (await connection(scope, github, rollup.contexts, rollup.id, "StatusCheckRollup", "contexts", checkFields)).map(check) : [],
  } };
}

export async function pullRequest(scope: string, known: PullRequestRef | undefined, github: Gh = gh): Promise<PullRequestDetails | null> {
  if (!isRepository(scope)) return null;
  const branch = await head(scope);
  if (!branch.ok) throw new Error(branch.failure.message);
  if (branch.value.detached) return null;
  const repository = await resolveRepository(scope, branch.value.name, github);
  if (known?.repo === repository.base.repo) {
    const read = await details(scope, known, github);
    if (read && read.pr.headRefName === branch.value.name && read.headRepositoryId === repository.head.id) return read.pr;
  }
  const resolved = await resolvePullRequest(scope, repository, branch.value.name, github);
  return resolved ? (await details(scope, resolved, github))?.pr ?? null : null;
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

export async function createPullRequest(scope: string, input: PullRequestInput, github: Gh = gh): Promise<string> {
  if (typeof input.title !== "string" || !input.title.trim() || typeof input.body !== "string") throw new Error("Enter a pull request title.");
  const { branch, head, repository } = await pushTarget(scope, github);
  if (head !== input.head) throw new Error("HEAD moved after the branch was read. Read it again.");
  if (await remoteHead(scope, repository.remote, branch) !== head) throw new Error(`Push the branch first. ${repository.remote} does not have the current HEAD of ${branch}.`);
  const existing = await resolvePullRequest(scope, repository, branch, github);
  if (existing?.state === "OPEN") throw new Error(`Pull request #${existing.number} is already open for ${branch}.`);
  const stack = await localStack(scope, branch);
  const base = stack ? stackParent(stack, branch) : repository.base.defaultBranch;
  const owner = repository.head.repo.split("/")[0];
  return (await github(scope, ["pr", "create", "--repo", repository.base.repo, "--head", `${owner}:${branch}`, "--base", base, "--title", input.title, "--body", input.body, ...(input.draft ? ["--draft"] : [])])).trim();
}

function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_+/=-]+$/.test(value) && value.length <= 256; }
function validate(ref: PullRequestRef | undefined): void {
  if (!ref || typeof ref.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repo) || !Number.isSafeInteger(ref.number) || ref.number < 1 || !validId(ref.id)) throw new Error("Invalid pull request reference.");
}

async function target(scope: string, ref: PullRequestRef, github: Gh): Promise<ResolvedPullRequest & { branch: string }> {
  const selected = await head(scope);
  const branch = selected.ok && !selected.value.detached ? selected.value.name : undefined;
  const pr = branch === undefined ? undefined : await resolvePullRequest(scope, await resolveRepository(scope, branch, github), branch, github);
  if (!pr || pr.id !== ref.id || pr.number !== ref.number || pr.repo !== ref.repo) throw new Error("The branch's pull request has changed. Reload it before continuing.");
  return { ...pr, branch: branch! };
}

export async function changePullRequest(scope: string, action: "rebase" | "merge", input: PullRequestActionInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (action !== "rebase" && action !== "merge") throw new Error("Invalid pull request action.");
  if (!/^[0-9a-f]{40,64}$/.test(input.headOid) || typeof input.baseBranch !== "string") throw new Error("Invalid pull request action.");
  if (action === "merge" && !["MERGE", "SQUASH", "REBASE"].includes(input.method ?? "")) throw new Error("Invalid merge method.");
  if (action === "rebase") await cleanStack(scope);
  const pr = await target(scope, input.pr, github);
  if (pr.state !== "OPEN" || pr.headRefOid !== input.headOid || pr.baseBranch !== input.baseBranch) throw new Error("The pull request has changed. Reload it before continuing.");
  if (action === "merge") {
    if (pr.isDraft) throw new Error("Mark the pull request ready for review before you merge it.");
    await api(scope, github, "mutation($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!){mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}){pullRequest{id state}}}", { id: pr.id, head: input.headOid, method: input.method! });
    return;
  }
  await git(scope, ["check-ref-format", `refs/heads/${pr.baseBranch}`]);
  const before = await git(scope, ["rev-parse", "HEAD"]);
  let baseUrl = `https://github.com/${pr.repo}.git`;
  for (const remote of (await git(scope, ["remote"])).split("\n").filter(Boolean)) {
    const url = await git(scope, ["remote", "get-url", remote]);
    const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
    if (repo?.toLowerCase() === pr.repo.toLowerCase()) { baseUrl = url; break; }
  }
  await git(scope, ["fetch", "--no-tags", baseUrl, `refs/heads/${pr.baseBranch}`]);
  const base = await git(scope, ["rev-parse", "FETCH_HEAD"]);
  const latest = await target(scope, input.pr, github);
  if (latest.state !== "OPEN" || latest.headRefOid !== input.headOid || latest.baseBranch !== input.baseBranch) throw new Error("The pull request has changed. Reload it before rebasing.");
  const branch = await head(scope);
  if (!branch.ok || branch.value.detached || branch.value.name !== pr.branch || await git(scope, ["rev-parse", "HEAD"]) !== before) throw new Error("The branch has changed. Reload it before rebasing.");
  await cleanStack(scope);
  const rebased = await run(scope, ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false", "rebase", base], GIT_WRITE_TIMEOUT_MS);
  if (!rebased.ok) {
    const aborted = await run(scope, ["rebase", "--abort"], GIT_WRITE_TIMEOUT_MS);
    throw new Error(`${rebased.failure.message}\n${aborted.ok ? "Rebase aborted. Local changes were not pushed." : `Rebase did not complete. Check Git status in the Shell; if a rebase remains, run git rebase --abort. ${aborted.failure.message}`}`);
  }
}

async function requireThread(scope: string, pr: ResolvedPullRequest, thread: string, github: Gh): Promise<void> {
  const data = await api<{ node: { pullRequest?: { id: string } } | null }>(scope, github, "query($thread:ID!){node(id:$thread){... on PullRequestReviewThread{pullRequest{id}}}}", { thread });
  if (data.node?.pullRequest?.id !== pr.id) throw new Error("This review thread is not on this pull request. Reload it before continuing.");
}

export async function commentPullRequest(scope: string, input: PullRequestCommentInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (typeof input.body !== "string" || !input.body.trim() || (input.threadId !== undefined && !validId(input.threadId))) throw new Error("Invalid comment input.");
  const pr = await target(scope, input.pr, github);
  if (input.threadId !== undefined) {
    await requireThread(scope, pr, input.threadId, github);
    await api(scope, github, "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}", { id: input.threadId, body: input.body });
  } else await api(scope, github, "mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{id}}}}", { id: pr.id, body: input.body });
}

export async function resolvePullRequestThread(scope: string, input: PullRequestThreadInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (!validId(input.threadId) || typeof input.resolved !== "boolean") throw new Error("Invalid thread input.");
  await requireThread(scope, await target(scope, input.pr, github), input.threadId, github);
  const operation = input.resolved ? "resolveReviewThread" : "unresolveReviewThread";
  await api(scope, github, `mutation($id:ID!){${operation}(input:{threadId:$id}){thread{id}}}`, { id: input.threadId });
}

export async function editPullRequest(scope: string, input: PullRequestEditInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (typeof input.title !== "string" || !input.title.trim() || typeof input.body !== "string") throw new Error("Enter a pull request title.");
  const pr = await target(scope, input.pr, github);
  await api(scope, github, "mutation($id:ID!,$title:String!,$body:String!){updatePullRequest(input:{pullRequestId:$id,title:$title,body:$body}){pullRequest{id}}}", { id: pr.id, title: input.title, body: input.body });
}

export async function setPullRequestDraft(scope: string, input: PullRequestDraftInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (typeof input.draft !== "boolean") throw new Error("Invalid draft input.");
  const pr = await target(scope, input.pr, github);
  const operation = input.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  await api(scope, github, `mutation($id:ID!){${operation}(input:{pullRequestId:$id}){pullRequest{id}}}`, { id: pr.id });
}

export async function rerunPullRequestChecks(scope: string, input: PullRequestRerunInput, github: Gh = gh): Promise<void> {
  validate(input?.pr);
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) throw new Error("Invalid run ID.");
  const pr = await target(scope, input.pr, github);
  const run = JSON.parse(await github(scope, ["api", `repos/${pr.repo}/actions/runs/${input.runId}`])) as { head_sha?: string };
  if (run.head_sha !== pr.headRefOid) throw new Error("This run is not for the current head of the pull request. Reload it before you re-run checks.");
  await github(scope, ["run", "rerun", String(input.runId), "--failed", "--repo", pr.repo]);
}

const checkLogLines = 80;

export async function checkLog(scope: string, ref: PullRequestRef, jobId: number, github: Gh = gh): Promise<PullRequestCheckLog | null> {
  validate(ref);
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error("Invalid job ID.");
  const pr = await target(scope, ref, github);
  const job = JSON.parse(await github(scope, ["api", `repos/${pr.repo}/actions/jobs/${jobId}`])) as { head_sha?: string };
  if (job.head_sha !== pr.headRefOid) throw new Error("This job is not for the current head of the pull request. Reload it before you add its log.");
  let log: string;
  try { log = await github(scope, ["api", `repos/${pr.repo}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"]); }
  catch { return null; }
  const lines = log.replace(/\s+$/, "").split(/\r\n?|\n/).map(line => line
    .replaceAll("\ufeff", "")
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
    .replace(/\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~])/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
  const end = lines.findLastIndex(line => line.startsWith("##[error]")) + 1 || lines.length;
  const start = Math.max(0, end - checkLogLines);
  return { text: lines.slice(start, end).join("\n"), truncated: start > 0 || end < lines.length };
}
