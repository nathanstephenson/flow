import { run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { api, gh, type Gh } from "./github.ts";
import type { CheckStatus, PullRequestSummary } from "../protocol/git.ts";
import type { PullRequestRef } from "../protocol/pull-request.ts";

export type Repository = {
  remote: string;
  url: string;
  head: { repo: string; id: string };
  base: { repo: string; id: string; defaultBranch: string };
};
export type ResolvedPullRequest = PullRequestRef & PullRequestSummary & { title: string };

type RepositoryView = { id?: string; defaultBranchRef?: { name: string } | null; isFork?: boolean; parent?: { name: string; owner: { login: string } } | null };
type Candidate = {
  id: string; number: number; url: string; title: string; state: PullRequestSummary["state"]; isDraft: boolean; reviewDecision: string | null;
  updatedAt: string; closedAt: string | null; headRepository: { id: string } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  reviewThreads: { nodes: { isResolved: boolean }[] };
};

const identities = new Map<string, Pick<Repository, "head" | "base">>();

async function git(scope: string, args: string[]): Promise<string> {
  const result = await run(scope, args, GIT_READ_TIMEOUT_MS);
  if (!result.ok) {
    if (result.failure.message.includes("ENOENT")) throw new Error("Git is missing. Install git on the Session Host.");
    throw new Error(`Git ${result.failure.attempted} failed: ${result.failure.message}`);
  }
  return result.value.trim();
}

async function config(scope: string, key: string): Promise<string | undefined> {
  const result = await run(scope, ["config", "--get", key], GIT_READ_TIMEOUT_MS);
  const value = result.ok ? result.value.trim() : "";
  return value && value !== "." ? value : undefined;
}

async function pushRemote(scope: string, branch: string | undefined): Promise<string> {
  const remotes = (await git(scope, ["remote"])).split("\n").filter(Boolean);
  if (remotes.length === 0) throw new Error("No remote is configured. Add a GitHub remote.");
  const keys = branch ? [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`] : ["remote.pushDefault"];
  for (const key of keys) {
    const configured = await config(scope, key);
    if (configured) return configured;
  }
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0]!;
  throw new Error("Cannot identify the push remote for this branch. Set branch.<name>.pushRemote or remote.pushDefault.");
}

async function view(scope: string, repo: string, github: Gh): Promise<RepositoryView & { id: string; defaultBranch: string }> {
  const info = JSON.parse(await github(scope, ["repo", "view", repo, "--json", "id,defaultBranchRef,isFork,parent"])) as RepositoryView;
  if (!info.id) throw new Error(`GitHub did not return the ID of ${repo}.`);
  if (!info.defaultBranchRef?.name) throw new Error(`GitHub has no default branch for ${repo}. Create it first.`);
  return { ...info, id: info.id, defaultBranch: info.defaultBranchRef.name };
}

export async function resolveRepository(scope: string, branch: string | undefined, github: Gh = gh): Promise<Repository> {
  const remote = await pushRemote(scope, branch);
  const url = await git(scope, ["remote", "get-url", "--push", remote]);
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url)?.[1];
  if (!repo) throw new Error("This remote is not a supported github.com repository URL.");
  const key = `${scope}\0${remote}\0${url}`;
  let identity = identities.get(key);
  if (!identity) {
    await github(scope, ["auth", "status", "--hostname", "github.com"]);
    const head = await view(scope, repo, github);
    const parent = head.isFork && head.parent ? `${head.parent.owner.login}/${head.parent.name}` : undefined;
    const base = parent ? await view(scope, parent, github) : head;
    identity = { head: { repo, id: head.id }, base: { repo: parent ?? repo, id: base.id, defaultBranch: base.defaultBranch } };
    identities.set(key, identity);
  }
  return { remote, url, ...identity };
}

function checks(rollup: { state: string } | null | undefined): CheckStatus {
  if (!rollup) return "none";
  if (rollup.state === "SUCCESS") return "passing";
  if (rollup.state === "FAILURE" || rollup.state === "ERROR") return "failing";
  return "pending";
}

export async function resolvePullRequest(scope: string, repository: Repository, branch: string, github: Gh = gh): Promise<ResolvedPullRequest | undefined> {
  const [owner, name] = repository.base.repo.split("/");
  const data = await api<{ repository: { pullRequests: { nodes: Candidate[] } } }>(scope, github,
    "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$branch,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number url title state isDraft reviewDecision updatedAt closedAt headRepository{id} commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}}}}}",
    { owner: owner!, name: name!, branch });
  const matches = data.repository.pullRequests.nodes.filter(pr => pr.headRepository?.id === repository.head.id);
  matches.sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  const pr = matches[0];
  if (!pr) return undefined;
  return {
    repo: repository.base.repo, id: pr.id, number: pr.number, url: pr.url, title: pr.title, state: pr.state, isDraft: pr.isDraft,
    checks: checks(pr.commits.nodes[0]?.commit.statusCheckRollup), reviewDecision: pr.reviewDecision,
    unresolvedThreads: pr.reviewThreads.nodes.filter(thread => !thread.isResolved).length,
  };
}
