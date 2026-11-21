import { commonGitPath, localStack, localStacks } from "./stack-metadata.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { localRepository, resolveRepository } from "./repository.ts";
import { api, gh, type Gh } from "./github.ts";
import { head, localBranches, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { StackInput, StackStatus, StackView } from "../protocol/stack.ts";

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

const install = "Install gh-stack on the Session Host: gh extension install github/gh-stack. Run gh auth login if needed.";
const notInStack = /is not part of a stack/i;

export async function stackStatus(scope: string, github: Gh = gh): Promise<StackStatus> {
  try { await github(scope, ["stack", "--help"]); }
  catch { return { available: false, conflicts: [], rebasing: false }; }
  const conflicts = (await git(scope, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
  const rebasing = await access(await commonGitPath(scope, "gh-stack-rebase-state")).then(() => true, () => false);
  const status: StackStatus = { available: true, conflicts, rebasing };
  if (rebasing) return status;
  const current = await head(scope);
  if (!current.ok) throw new Error(current.failure.message);
  if (current.value.detached) return { ...status, notice: "HEAD is detached. Switch to a branch to see its stack." };
  try { return { ...status, view: parseStack(await github(scope, ["stack", "view", "--json"])) }; }
  catch (error) { if (!notInStack.test(String(error))) throw error; }
  const branch = current.value.name;
  const [listed, stacks, repository] = await Promise.all([localBranches(scope), localStacks(scope), localRepository(scope, branch)]);
  if (!listed.ok) throw new Error(listed.failure.message);
  const trunk = repository?.defaultBranches.find(name => listed.value.includes(name));
  if (branch === trunk || stacks.some(stack => stack.trunk.branch === branch)) return { ...status, notice: `${branch} is a trunk. Switch to another branch to create a stack.` };
  const stacked = new Set(stacks.flatMap(stack => stack.branches.map(member => member.branch)));
  return { ...status, create: { current: branch, ...(trunk ? { trunk } : {}), branches: listed.value, unstacked: listed.value.filter(name => !stacked.has(name)) } };
}

const titles = new Map<string, { key: string; found: Map<number, string> }>();

export async function stackTitles(scope: string, view: StackView, github: Gh = gh): Promise<void> {
  const numbers = view.branches.flatMap(branch => branch.pr ? [branch.pr.number] : []);
  if (!numbers.length) return;
  try {
    const repository = await resolveRepository(scope, view.currentBranch, github);
    const key = JSON.stringify([repository.base.repo, view.branches.map(branch => branch.pr && [branch.pr.number, branch.pr.state])]);
    let found = titles.get(scope)?.key === key ? titles.get(scope)!.found : undefined;
    if (!found) {
      const [owner, name] = repository.base.repo.split("/");
      const data = await api<{ repository: Record<string, { title: string } | null> }>(scope, github,
        `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map(number => `pr${number}:pullRequest(number:${number}){title}`).join(" ")}}}`, { owner: owner!, name: name! });
      found = new Map(numbers.map(number => [number, data.repository[`pr${number}`]?.title ?? ""]));
      titles.set(scope, { key, found });
    }
    for (const branch of view.branches) if (branch.pr && found.get(branch.pr.number)) branch.pr.title = found.get(branch.pr.number)!;
  } catch { return; }
}

export async function cleanStack(scope: string): Promise<void> {
  if ((await git(scope, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) throw new Error("This Scope has uncommitted changes. Commit them first. Stack operations never stash changes.");
  const paths = await Promise.all(["rebase-merge", "rebase-apply", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map(async operation => resolve(scope, (await git(scope, ["rev-parse", "--git-path", operation])).trim())));
  for (const path of [...paths, await commonGitPath(scope, "gh-stack-rebase-state")]) {
    if (await access(path).then(() => true, () => false)) throw new Error("Finish or abort the current Git operation first.");
  }
}

export async function stackFingerprint(scope: string, view: StackView, sync = false, github: Gh = gh): Promise<string> {
  let membership: unknown;
  if (sync) {
    if (view.currentBranch === view.trunk) throw new Error("Switch to a branch in the stack before reviewing Sync.");
    const stack = await localStack(scope, view.currentBranch);
    if (stack?.id) {
      const remote = JSON.parse(await github(scope, ["api", `repos/{owner}/{repo}/stacks/${stack.id}`, "--jq", "{id,pull_requests:(.pull_requests|map({number,head:{ref:.head.ref}}))}"])) as { id: number; pull_requests: { number: number; head: { ref: string } }[] };
      if (!remote || !Number.isInteger(remote.id)) throw new Error("Cannot verify remote stack membership.");
      membership = remote;
      if (remote && (!Array.isArray(remote.pull_requests) || JSON.stringify(remote.pull_requests.map(pr => [pr.head?.ref, pr.number])) !== JSON.stringify(stack.branches.filter(b => b.pullRequest).map(b => [b.branch, b.pullRequest!.number])))) throw new Error("Remote stack membership differs from the local stack. Review and import remote branches with gh stack outside Flow, then review Sync again.");
    }
  }
  const refs = await git(scope, ["show-ref", "--head"]);
  const config = await git(scope, ["config", "--local", "--list"]);
  return createHash("sha256").update(JSON.stringify({ view, refs, config, membership })).digest("hex");
}

async function validateInit(scope: string, trunk: unknown, branches: string[], github: Gh): Promise<void> {
  try { await github(scope, ["stack", "--help"]); }
  catch { throw new Error(install); }
  const listed = await localBranches(scope);
  if (!listed.ok) throw new Error(listed.failure.message);
  if (typeof trunk !== "string" || !listed.value.includes(trunk)) throw new Error(`${String(trunk)} is not a local branch.`);
  const stacked = new Set((await localStacks(scope)).flatMap(stack => stack.branches.map(member => member.branch)));
  for (const [index, branch] of branches.entries()) {
    if (!listed.value.includes(branch)) throw new Error(`${branch} is not a local branch.`);
    if (branch === trunk) throw new Error(`${branch} is the trunk. Choose it only as the trunk.`);
    if (branches.indexOf(branch) !== index) throw new Error(`${branch} is listed twice.`);
    if (stacked.has(branch)) throw new Error(`${branch} is already in a stack.`);
  }
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
  if (action === "init" || action === "add" || action === "checkout") {
    if (!Array.isArray(input.branches) || !input.branches.length || (action !== "init" && input.branches.length !== 1)) throw new Error("Enter a branch name.");
    for (const branch of input.branches) {
      if (typeof branch !== "string" || branch.startsWith("-") || !branch.trim()) throw new Error("Invalid branch name.");
      await git(scope, ["check-ref-format", "--branch", branch]);
    }
    if (action === "init") {
      await validateInit(scope, input.trunk, input.branches, github);
      args.push("--base", input.trunk!);
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

export const stackConflictMessage = "Resolve the current gh stack rebase conflicts in this Scope. Inspect the Stack rebase state and conflict files first. Preserve the intended changes and stage only resolved files. Run gh stack rebase --continue only after git diff --name-only --diff-filter=U is empty and all conflicts are resolved. Repeat for further conflicts; stop and report if the intended resolution is unclear. This request permits local conflict repair and Stack rebase continuation only. Do not push, submit, sync, merge, or restructure the stack. Report the result so I can review it before any separate Sync confirmation.";
