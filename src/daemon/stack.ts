import { localStack, localStacks } from "./stack-metadata.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gh, repositoryTarget, type Gh } from "./publish.ts";
import { head, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { StackCandidate, StackInput, StackStatus, StackView } from "../protocol/stack.ts";

async function git(scope: string, args: string[], write = false): Promise<string> {
  const result = await run(scope, args, write ? GIT_WRITE_TIMEOUT_MS : GIT_READ_TIMEOUT_MS);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

export function parseStack(raw: string): StackView {
  const value = JSON.parse(raw) as StackView;
  if (!value || typeof value.trunk !== "string" || typeof value.currentBranch !== "string" || !Array.isArray(value.branches) || value.branches.some((branch) =>
    !branch || typeof branch.name !== "string" || [branch.isCurrent, branch.isMerged, branch.isQueued, branch.needsRebase].some((flag) => typeof flag !== "boolean") ||
    (branch.pr !== undefined && (!branch.pr || !Number.isInteger(branch.pr.number) || typeof branch.pr.state !== "string")))) throw new Error("Invalid gh stack view JSON.");
  return value;
}

export async function discoverStack(scope: string, github: Gh = gh): Promise<StackCandidate | undefined> {
  const current = await head(scope);
  if (!current.ok || current.value.detached) return;
  const stacks = await localStacks(scope);
  const tracked = new Set(stacks.flatMap(s => [s.trunk.branch, ...s.branches.map(b => b.branch)]));
  if (stacks.some(s => s.branches.some(b => b.branch === current.value.name))) return;
  const refs = (await git(scope, ["for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads"])).trim().split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]);
  let destination: Awaited<ReturnType<typeof repositoryTarget>>;
  type PR = { number: number; title?: string; html_url?: string; state: string; merged_at: string | null; head: { ref: string; repo: { node_id: string } | null }; base: { ref: string; repo: { node_id: string } } };
  let prs: PR[];
  try {
    destination = await repositoryTarget(scope, github);
    const pages: PR[][] = JSON.parse(await github(scope, ["api", "--paginate", "--slurp", `repos/${destination.repo}/pulls?state=all&per_page=100`]));
    if (!destination.id || !Array.isArray(pages) || pages.some(page => !Array.isArray(page))) return;
    prs = pages.flat();
    if (prs.some(pr => !Number.isInteger(pr.number) || !pr.head?.ref || !pr.base?.ref || !["open", "closed"].includes(pr.state) || !(pr.merged_at === null || typeof pr.merged_at === "string"))) return;
  } catch { return; }
  const trunk = destination.defaultBranch;
  const base = refs.find(([name]) => name === trunk);
  if (!base) return;
  const chain: PR[] = [];
  let branch = current.value.name;
  const seen = new Set<string>();
  while (branch !== trunk) {
    if (seen.has(branch)) return;
    seen.add(branch);
    const parents = prs.filter(pr => pr.head.ref === branch);
    if (parents.length !== 1) return;
    chain.unshift(parents[0]!);
    branch = parents[0]!.base.ref;
  }
  branch = chain.at(-1)?.head.ref ?? trunk;
  while (true) {
    const children = prs.filter(pr => pr.base.ref === branch);
    if (!children.length) break;
    if (children.length !== 1 || seen.has(children[0]!.head.ref)) return;
    chain.push(children[0]!);
    branch = children[0]!.head.ref;
    seen.add(branch);
  }
  if (chain.length < 2) return;
  for (const pr of chain) {
    if (pr.head.ref === trunk || tracked.has(pr.head.ref) || !refs.some(([name]) => name === pr.head.ref) ||
      pr.head.repo?.node_id !== destination.id || pr.base.repo?.node_id !== destination.id ||
      prs.filter(other => other.head.ref === pr.head.ref).length !== 1 ||
      (pr.base.ref !== trunk && prs.filter(other => other.base.ref === pr.base.ref).length !== 1)) return;
  }
  const pullRequests = chain.map(pr => ({ branch: pr.head.ref, number: pr.number, state: pr.merged_at ? "MERGED" : pr.state.toUpperCase(), ...(pr.title && pr.html_url ? { title: pr.title, url: pr.html_url } : {}) }));
  return { trunk, branches: chain.map(pr => pr.head.ref), pullRequests, fingerprint: createHash("sha256").update(JSON.stringify({ destination, base, chain, refs, current: current.value.name })).digest("hex") };
}

export async function stackStatus(scope: string, github: Gh = gh): Promise<StackStatus> {
  const status: StackStatus = { available: false, conflicts: [], rebasing: false };
  try { await github(scope, ["stack", "--help"]); }
  catch { return { ...status, problem: "Install GitHub CLI, then run gh extension install github/gh-stack on the Session Host. Run gh auth login if needed." }; }
  status.available = true;
  try {
    status.conflicts = (await git(scope, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
    const path = (await git(scope, ["rev-parse", "--git-path", "gh-stack-rebase-state"])).trim();
    status.rebasing = await access(resolve(scope, path)).then(() => true, () => false);
    try { status.view = parseStack(await github(scope, ["stack", "view", "--json"])); }
    catch (error) {
      if (!/current branch .+ (?:is not|not) (?:a )?part of (?:a |any )?stack/i.test(String(error)) || await localStack(scope, (await git(scope, ["branch", "--show-current"])).trim())) throw error;
    }
    if (status.view) {
      await Promise.all(status.view.branches.map(async ({ pr }) => {
        if (!pr) return;
        const details = JSON.parse(await github(scope, ["pr", "view", pr.url || String(pr.number), "--json", "title,url"]));
        if (typeof details.title !== "string" || typeof details.url !== "string") throw new Error("Cannot load stack PR titles and links.");
        pr.title = details.title;
        pr.url = details.url;
      }));
    }
    if (!status.view && !status.rebasing) {
      const candidate = await discoverStack(scope, github);
      if (candidate) status.candidate = candidate;
    }
  } catch (error) { status.problem = error instanceof Error ? error.message : String(error); }
  return status;
}

export async function cleanStack(scope: string): Promise<void> {
  if ((await git(scope, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) throw new Error("This Scope has uncommitted changes. Use Publish or commit them first. Stack operations never stash changes.");
  for (const operation of ["rebase-merge", "rebase-apply", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "gh-stack-rebase-state"]) {
    const path = (await git(scope, ["rev-parse", "--git-path", operation])).trim();
    if (await access(resolve(scope, path)).then(() => true, () => false)) throw new Error("Finish or abort the current Git operation first.");
  }
}

export async function stackFingerprint(scope: string, view: StackView, sync = false, github: Gh = gh): Promise<string> {
  let membership: unknown;
  if (sync) {
    if (view.currentBranch === view.trunk) throw new Error("Switch to a branch in the stack before reviewing Sync.");
    const stack = await localStack(scope, view.currentBranch);
    if (stack?.id) {
      const pages = JSON.parse(await github(scope, ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/stacks?per_page=100"])) as { id: number; pull_requests: { number: number; head: { ref: string } }[] }[][];
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("Cannot verify remote stack membership.");
      const remote = pages.flat().find(s => String(s.id) === stack.id);
      membership = remote ?? null;
      if (remote && (!Array.isArray(remote.pull_requests) || JSON.stringify(remote.pull_requests.map(pr => [pr.head?.ref, pr.number])) !== JSON.stringify(stack.branches.filter(b => b.pullRequest).map(b => [b.branch, b.pullRequest!.number])))) throw new Error("Remote stack membership differs from the local stack. Review and import remote branches with gh stack outside Flow, then review Sync again.");
    }
  }
  const refs = await git(scope, ["show-ref", "--head"]);
  const config = await git(scope, ["config", "--local", "--list"]);
  return createHash("sha256").update(JSON.stringify({ view, refs, config, membership })).digest("hex");
}

export async function changeStack(scope: string, input: StackInput, github: Gh = gh): Promise<string> {
  const { action } = input;
  if (!["init", "add", "checkout", "rebase", "continue", "abort", "submit", "sync"].includes(action)) throw new Error("Unknown Stack action.");
  if (action === "continue" || action === "abort") {
    const state = await stackStatus(scope, github);
    if (!state.rebasing) throw new Error("No Stack rebase is in progress.");
    if (action === "continue" && state.conflicts.length) throw new Error("Resolve and stage all conflict files before continuing.");
  } else await cleanStack(scope);
  const args = ["stack", action];
  if (action === "init") {
    const candidate = await discoverStack(scope, github);
    if (!candidate || input.fingerprint !== candidate.fingerprint || JSON.stringify(input.branches) !== JSON.stringify(candidate.branches)) throw new Error("The existing branch chain changed or is not eligible. Refresh Stack and review it again.");
    args.push("--base", candidate.trunk);
  }
  if (action === "init" || action === "add" || action === "checkout") {
    if (!Array.isArray(input.branches) || !input.branches.length || (action !== "init" && input.branches.length !== 1)) throw new Error("Enter a branch name.");
    for (const branch of input.branches) {
      if (typeof branch !== "string" || branch.startsWith("-") || !branch.trim()) throw new Error("Invalid branch name.");
      await git(scope, ["check-ref-format", "--branch", branch]);
    }
    if (action === "checkout") {
      const state = await stackStatus(scope, github);
      const branch = input.branches[0]!;
      if (!state.view?.branches.some(b => b.name === branch)) throw new Error("Choose a branch in the current local stack.");
      await git(scope, ["show-ref", "--verify", `refs/heads/${branch}`]);
      return git(scope, ["switch", "--no-guess", "--", branch], true);
    }
    args.push(...input.branches);
  }
  if (action === "continue" || action === "abort") args.splice(1, 1, "rebase", `--${action}`);
  if (action === "submit") args.push("--auto");
  return github(scope, args);
}

export const stackConflictMessage = "Resolve the current gh stack rebase conflicts in this Scope. Inspect the Stack rebase state and conflict files first. Preserve the intended changes and stage only resolved files. Run gh stack rebase --continue only after git diff --name-only --diff-filter=U is empty and all conflicts are resolved. Repeat for further conflicts; stop and report if the intended resolution is unclear. This request permits local conflict repair and Stack rebase continuation only. Do not push, publish, submit, sync, merge, or restructure the stack. Report the result so I can review it before any separate Sync confirmation.";
