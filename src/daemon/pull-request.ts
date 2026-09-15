import { gh, type Gh } from "./publish.ts";
import { cleanStack } from "./stack.ts";
import type { MergeMethod, PullRequestActionInput } from "../protocol/pull-request.ts";
import { head, isRepository, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { PullRequestComment, PullRequestDetails, PullRequestCommentInput, PullRequestThreadInput, PullRequestRef, PullRequestThread } from "../protocol/pull-request.ts";

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
const page = "pageInfo { hasNextPage endCursor }";
const commentFields = "id author { login } body url createdAt";
type Comment = Omit<PullRequestComment, "author"> & { author: { login: string } | null };
const comment = (value: Comment): PullRequestComment => ({ ...value, author: value.author?.login ?? "[deleted]" });

async function api<T>(scope: string, github: Gh, query: string, variables: Record<string, string | number | boolean | null>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null) args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
  }
  const result = JSON.parse(await github(scope, args)) as { data?: T; errors?: { message: string }[] };
  if (result.errors?.length || !result.data) throw new Error(result.errors?.map(error => error.message).join("; ") || "GitHub returned no data.");
  return result.data;
}

async function pages<T>(load: (cursor: string | null) => Promise<Connection<T>>): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let count = 0; count < 1000; count++) {
    const connection = await load(cursor);
    result.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return result;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error("GitHub returned an invalid page cursor.");
    seen.add(cursor);
  }
  throw new Error("GitHub pagination limit exceeded.");
}

async function connection<T>(scope: string, github: Gh, id: string, type: string, field: string, fields: string): Promise<T[]> {
  return pages(async cursor => {
    const data = await api<{ node: Record<string, Connection<T>> }>(scope, github,
      `query($id:ID!,$cursor:String){node(id:$id){... on ${type}{${field}(first:100,after:$cursor){nodes{${fields}} ${page}}}}}`, { id, cursor });
    return data.node[field]!;
  });
}

type Candidate = PullRequestRef & { state: string; updatedAt: string; closedAt: string | null; headRepository: { id: string } | null };
async function select(scope: string, github: Gh): Promise<PullRequestRef | null> {
  if (!isRepository(scope)) return null;
  const branch = await head(scope);
  if (!branch.ok) throw new Error(branch.failure.message);
  if (branch.value.detached) return null;
  const base = JSON.parse(await github(scope, ["repo", "view", "--json", "nameWithOwner"])) as { nameWithOwner: string };
  const remoteNames = await run(scope, ["remote"], GIT_READ_TIMEOUT_MS);
  if (!remoteNames.ok) throw new Error(remoteNames.failure.message);
  const names = remoteNames.value.trim().split("\n").filter(Boolean);
  const configured = await run(scope, ["config", "--get", `branch.${branch.value.name}.pushRemote`], GIT_READ_TIMEOUT_MS);
  const pushDefault = await run(scope, ["config", "--get", "remote.pushDefault"], GIT_READ_TIMEOUT_MS);
  const upstream = await run(scope, ["config", "--get", `branch.${branch.value.name}.remote`], GIT_READ_TIMEOUT_MS);
  const preferred = [configured, pushDefault, upstream].find(value => value.ok && value.value.trim() !== ".");
  const remote = preferred?.ok ? preferred.value.trim() : names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;
  if (!remote) throw new Error("Cannot identify this branch's source remote.");
  const url = await run(scope, ["remote", "get-url", "--push", remote], GIT_READ_TIMEOUT_MS);
  if (!url.ok) throw new Error(url.failure.message);
  const source = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(url.value.trim())?.[1];
  if (!source) throw new Error("Cannot identify the GitHub source repository.");
  const sourceRepo = JSON.parse(await github(scope, ["repo", "view", source, "--json", "id"])) as { id?: string };
  if (!sourceRepo.id) throw new Error("Cannot verify the source repository: GitHub did not return its ID.");
  const [owner, name] = base.nameWithOwner.split("/");
  const candidates = await pages<Candidate>(async cursor => {
    const data = await api<{ repository: { pullRequests: Connection<Candidate> } }>(scope, github,
      `query($owner:String!,$name:String!,$branch:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(headRefName:$branch,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number state updatedAt closedAt headRepository{id}} ${page}}}}`,
      { owner: owner!, name: name!, branch: branch.value.name, cursor });
    return data.repository.pullRequests;
  });
  const matches = candidates.filter(pr => pr.headRepository?.id === sourceRepo.id);
  matches.sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  const chosen = matches[0];
  return chosen ? { repo: base.nameWithOwner, number: chosen.number, id: chosen.id } : null;
}

export async function pullRequest(scope: string, github: Gh = gh): Promise<PullRequestDetails | null> {
  const ref = await select(scope, github);
  if (!ref) return null;
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
