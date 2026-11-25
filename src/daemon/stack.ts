import { commonGitPath, localStack, localStacks } from "./stack-metadata.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { localRepository, mergeMethods, mergeSettingsFields, resolveRepository, type MergeSettings } from "./repository.ts";
import { api, gh, type Gh } from "./github.ts";
import { head, localBranches, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import { stackMergeBlock, type StackInput, type StackStatus, type StackView } from "../protocol/stack.ts";
import type { MergeMethod } from "../protocol/pull-request.ts";

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
export const otherWorktreeRebase = "A stack rebase is in progress in another worktree.";
const queues = new Map<string, Promise<unknown>>();

async function runStack(scope: string, args: string[], github: Gh): Promise<string> {
  const key = await commonGitPath(scope, ".");
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => github(scope, ["stack", ...args]));
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}

async function gitPathExists(scope: string, name: string): Promise<boolean> {
  return access(resolve(scope, (await git(scope, ["rev-parse", "--git-path", name])).trim())).then(() => true, () => false);
}

export async function stackStatus(scope: string, github: Gh = gh): Promise<StackStatus> {
  try { await runStack(scope, ["--help"], github); }
  catch { return { available: false, conflicts: [], rebasing: false }; }
  const conflicts = (await git(scope, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
  const stackRebase = await access(await commonGitPath(scope, "gh-stack-rebase-state")).then(() => true, () => false);
  const rebasing = stackRebase && (await gitPathExists(scope, "rebase-merge") || await gitPathExists(scope, "rebase-apply"));
  const status: StackStatus = { available: true, conflicts, rebasing };
  if (rebasing) return status;
  if (stackRebase) return { ...status, notice: otherWorktreeRebase };
  const current = await head(scope);
  if (!current.ok) throw new Error(current.failure.message);
  if (current.value.detached) return { ...status, notice: "HEAD is detached. Switch to a branch to see its stack." };
  const branch = current.value.name;
  const [listed, stacks] = await Promise.all([localBranches(scope), localStacks(scope)]);
  if (!listed.ok) throw new Error(listed.failure.message);
  if (!listed.value.includes(branch)) return { ...status, notice: "This branch has no commits yet. Commit first to create a stack." };
  const trunkNotice = `${branch} is a trunk. Switch to another branch to create a stack.`;
  if (stacks.some(stack => stack.trunk.branch === branch)) return { ...status, notice: trunkNotice };
  try { return { ...status, view: await withTracking(scope, parseStack(await runStack(scope, ["view", "--json"], github))) }; }
  catch (error) { if (!notInStack.test(String(error))) throw error; }
  const trunk = (await localRepository(scope, branch))?.defaultBranches.find(name => listed.value.includes(name));
  if (branch === trunk) return { ...status, notice: trunkNotice };
  const stacked = new Set(stacks.flatMap(stack => stack.branches.map(member => member.branch)));
  return { ...status, create: { current: branch, ...(trunk ? { trunk } : {}), branches: listed.value, unstacked: listed.value.filter(name => !stacked.has(name)) } };
}

async function withTracking(scope: string, view: StackView): Promise<StackView> {
  const tracking = new Map((await git(scope, ["for-each-ref", "--format=%(refname:short)%00%(upstream)%00%(upstream:track,nobracket)", "refs/heads"])).split("\n").map(line => line.split("\0")).map(([name, upstream, track]) => [name, upstream ? track ?? "" : undefined]));
  for (const branch of view.branches) {
    const track = tracking.get(branch.name);
    if (track === undefined || track === "gone") continue;
    branch.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
    branch.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
  }
  return view;
}

export async function stackMergeMethods(scope: string, view: StackView, github: Gh = gh): Promise<MergeMethod[]> {
  const [owner, name] = (await resolveRepository(scope, view.currentBranch, github)).base.repo.split("/");
  const { repository } = await api<{ repository: MergeSettings }>(scope, github, `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${mergeSettingsFields}}}`, { owner: owner!, name: name! });
  return mergeMethods(repository);
}

const mergeFlags: Record<MergeMethod, string> = { MERGE: "--merge", SQUASH: "--squash", REBASE: "--rebase" };

export async function mergeableStack(scope: string, github: Gh = gh): Promise<StackView> {
  const { view, notice } = await stackStatus(scope, github);
  if (!view) throw new Error(notice ?? "This branch is not in a stack.");
  await stackTitles(scope, view, github);
  const block = stackMergeBlock(view);
  if (block) throw new Error(block);
  return view;
}

type Title = { title: string; isDraft: boolean };

const titles = new Map<string, { key: string; expires: number; found: Map<number, Title> }>();

async function readTitles(scope: string, branch: string, numbers: number[], github: Gh): Promise<Map<number, Title>> {
  const [owner, name] = (await resolveRepository(scope, branch, github)).base.repo.split("/");
  const query = (list: number[]) => api<{ repository: Record<string, Title | null> }>(scope, github,
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${list.map(number => `pr${number}:pullRequest(number:${number}){title isDraft}`).join(" ")}}}`, { owner: owner!, name: name! });
  let wanted = numbers;
  let data: Awaited<ReturnType<typeof query>>;
  try { data = await query(wanted); }
  catch (error) {
    const missing = [...String(error).matchAll(/number of (\d+)/g)].map(match => Number(match[1]));
    wanted = numbers.filter(number => !missing.includes(number));
    if (!missing.length || !wanted.length) throw error;
    data = await query(wanted);
  }
  return new Map(wanted.flatMap(number => data.repository[`pr${number}`] ? [[number, data.repository[`pr${number}`]!]] : []));
}

export async function stackTitles(scope: string, view: StackView, github: Gh = gh): Promise<boolean> {
  for (const [cachedScope, entry] of titles) if (entry.expires <= Date.now()) titles.delete(cachedScope);
  const numbers = view.branches.flatMap(branch => branch.pr ? [branch.pr.number] : []);
  if (!numbers.length) return true;
  const key = JSON.stringify(view.branches.map(branch => branch.pr && [branch.pr.number, branch.pr.state]));
  const cached = titles.get(scope);
  let found = cached?.key === key ? cached.found : undefined;
  if (!found) {
    found = await readTitles(scope, view.currentBranch, numbers, github).catch(() => new Map<number, Title>());
    titles.set(scope, { key, expires: Date.now() + 5 * 60_000, found });
  }
  for (const branch of view.branches) if (branch.pr && found.has(branch.pr.number)) Object.assign(branch.pr, found.get(branch.pr.number));
  return numbers.every(number => found.has(number));
}

export async function cleanStack(scope: string): Promise<void> {
  if ((await git(scope, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) throw new Error("This Scope has uncommitted changes. Commit them first. Stack operations never stash changes.");
  for (const operation of ["rebase-merge", "rebase-apply", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (await gitPathExists(scope, operation)) throw new Error("Finish or abort the current Git operation first.");
  }
  if (await access(await commonGitPath(scope, "gh-stack-rebase-state")).then(() => true, () => false)) throw new Error("A stack rebase is in progress in this or another worktree. Finish or abort it first.");
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
  try { await runStack(scope, ["--help"], github); }
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
  if (!["init", "add", "checkout", "rebase", "continue", "abort", "submit", "sync", "merge"].includes(action)) throw new Error("Unknown Stack action.");
  if (action === "continue" || action === "abort") {
    const state = await stackStatus(scope, github);
    if (!state.rebasing) throw new Error(state.notice === otherWorktreeRebase ? otherWorktreeRebase : "No Stack rebase is in progress.");
    if (action === "continue" && state.conflicts.length) throw new Error("Resolve and stage all conflict files before continuing.");
  } else await cleanStack(scope);
  const args: string[] = [action];
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
  if (action === "continue" || action === "abort") args.splice(0, 1, "rebase", `--${action}`);
  if (action === "submit") args.push("--auto");
  if (action === "merge") {
    if (!input.method || !Object.hasOwn(mergeFlags, input.method)) throw new Error("Invalid merge method.");
    await mergeableStack(scope, github);
    args.push("--yes", mergeFlags[input.method]);
  }
  return runStack(scope, args, github);
}

export const stackConflictMessage = "Resolve the current gh stack rebase conflicts in this Scope. Inspect the Stack rebase state and conflict files first. Preserve the intended changes and stage only resolved files. Run gh stack rebase --continue only after git diff --name-only --diff-filter=U is empty and all conflicts are resolved. Repeat for further conflicts; stop and report if the intended resolution is unclear. This request permits local conflict repair and Stack rebase continuation only. Do not push, submit, sync, merge, or restructure the stack. Report the result so I can review it before any separate Sync confirmation.";
