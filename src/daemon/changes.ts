import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { head, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import { gh, type Gh } from "./github.ts";
import { localRepository, resolveRepository } from "./repository.ts";
import { readStatus } from "./git-state.ts";
import { localStack, localStacks, stackParent } from "./stack-metadata.ts";
import type { ChangesView, GitChanges, GitDiff, GitFile } from "../protocol/git.ts";

const SIDE_LIMIT = 250_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function git(scope: string, args: string[], write = false): Promise<string> {
  const result = await run(scope, args, write ? GIT_WRITE_TIMEOUT_MS : GIT_READ_TIMEOUT_MS);
  if (!result.ok) {
    if (result.failure.message.includes("ENOENT")) throw new Error("Git is missing. Install git on the Session Host.");
    throw new Error(`Git ${result.failure.attempted} failed: ${result.failure.message}`);
  }
  return result.value;
}

export async function files(scope: string): Promise<GitFile[]> {
  return (await readStatus(scope)).files;
}

export async function baseRef(scope: string, remote: string, branch: string, preferLocal: boolean): Promise<string | undefined> {
  const refs = [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`];
  for (const ref of preferLocal ? refs : refs.reverse()) {
    if ((await run(scope, ["rev-parse", "--verify", "--quiet", ref], GIT_READ_TIMEOUT_MS)).ok) return ref;
  }
  return undefined;
}

export async function rangeFiles(scope: string, base: string): Promise<GitFile[]> {
  const raw = (await git(scope, ["diff", "--name-status", "-z", "--no-renames", `${base}...HEAD`, "--"])).split("\0").filter(Boolean);
  const files: GitFile[] = [];
  for (let index = 0; index < raw.length; index += 2) files.push({ status: raw[index]!, path: raw[index + 1]! });
  return files;
}

export async function rangeCommits(scope: string, base: string): Promise<string[]> {
  return (await git(scope, ["log", "--format=%h %s", `${base}..HEAD`, "--"])).trim().split("\n").filter(Boolean);
}

export type PullRequestBase = (branch: string) => string | undefined;

async function branchBase(scope: string, pullRequestBase: PullRequestBase | undefined, github: Gh): Promise<string> {
  const current = await head(scope);
  const branch = current.ok && !current.value.detached ? current.value.name : undefined;
  const repository = await resolveRepository(scope, branch, github);
  const stack = branch === undefined ? undefined : await localStack(scope, branch);
  const parent = stack && stackParent(stack, branch!);
  const name = (branch === undefined ? undefined : pullRequestBase?.(branch)) ?? parent ?? repository.base.defaultBranch;
  const ref = await baseRef(scope, repository.remote, name, name === parent);
  if (!ref) throw new Error(`The base branch ${name} is not known locally. Fetch ${name} from ${repository.remote} to show the branch changes.`);
  return ref;
}

export async function changes(scope: string, view: ChangesView, pullRequestBase?: PullRequestBase, github: Gh = gh): Promise<GitChanges> {
  if (view !== "branch") return { files: await files(scope), commits: [] };
  const base = await branchBase(scope, pullRequestBase, github);
  return { files: await rangeFiles(scope, base), commits: await rangeCommits(scope, base), base: base.replace(/^refs\/(heads|remotes)\//, "") };
}

function added(path: string, content: string): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hunk = lines.length === 0 ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("")}${content.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
  return `--- /dev/null\n+++ b/${path}\n${hunk}`;
}

async function untracked(scope: string, path: string): Promise<GitDiff> {
  const full = resolve(scope, path);
  const stat = await lstat(full);
  if (stat.isSymbolicLink()) return { text: added(path, await readlink(full)) };
  if (!stat.isFile()) return { binary: true };
  if (stat.size > SIDE_LIMIT) return { tooLarge: true };
  const content = await readFile(full);
  if (content.includes(0)) return { binary: true };
  return { text: added(path, content.toString("utf8")) };
}

async function blobSize(scope: string, object: string): Promise<number> {
  const size = await run(scope, ["cat-file", "-s", object], GIT_READ_TIMEOUT_MS);
  return size.ok ? Number(size.value) : 0;
}

export async function diff(scope: string, view: ChangesView, path: string, pullRequestBase?: PullRequestBase, github: Gh = gh): Promise<GitDiff> {
  const base = view === "branch" ? await branchBase(scope, pullRequestBase, github) : undefined;
  const listed = base ? await rangeFiles(scope, base) : await files(scope);
  const file = listed.find(item => item.path === path);
  if (!file) throw new Error("This file is not in the list of changes. Read the list again.");
  if (file.status === "??") return untracked(scope, path);
  const from = base ? (await git(scope, ["merge-base", base, "HEAD"])).trim() : (await run(scope, ["rev-parse", "--verify", "--quiet", "HEAD"], GIT_READ_TIMEOUT_MS)).ok ? "HEAD" : EMPTY_TREE;
  const oldSize = await blobSize(scope, `${from}:${path}`);
  const newSize = base ? await blobSize(scope, `HEAD:${path}`) : (await lstat(resolve(scope, path)).catch(() => undefined))?.size ?? 0;
  if (oldSize > SIDE_LIMIT || newSize > SIDE_LIMIT) return { tooLarge: true };
  const range = base ? [from, "HEAD"] : [from];
  const numstat = await git(scope, ["--literal-pathspecs", "diff", "--numstat", ...range, "--", path]);
  if (numstat.startsWith("-\t-\t")) return { binary: true };
  return { text: await git(scope, ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", ...range, "--", path]) };
}

export async function canNameBranch(scope: string, branch: string, remote: string, pullRequest: boolean): Promise<boolean> {
  if (pullRequest) return false;
  if ((await localStacks(scope)).some(stack => stack.trunk.branch === branch || stack.branches.some(item => item.branch === branch))) return false;
  return !(await run(scope, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], GIT_READ_TIMEOUT_MS)).ok;
}

export async function commitContext(scope: string, branch: string | undefined, pullRequest: (branch: string) => boolean): Promise<Pick<GitChanges, "branch" | "defaultBranch" | "canRename">> {
  const repository = await localRepository(scope, branch).catch(() => undefined);
  const defaultBranch = repository?.defaultBranches[0];
  const canRename = Boolean(branch && repository?.github && defaultBranch && !repository.defaultBranches.includes(branch) && await canNameBranch(scope, branch, repository.remote, pullRequest(branch)));
  return { ...(branch ? { branch } : {}), ...(defaultBranch ? { defaultBranch } : {}), canRename };
}

export async function changesText(scope: string, view: ChangesView, paths: string[] | undefined, pullRequestBase?: PullRequestBase, github: Gh = gh): Promise<string> {
  const listed = await changes(scope, view, pullRequestBase, github);
  let text = listed.commits.length > 0 ? `Commits:\n${listed.commits.join("\n")}\n` : "";
  for (const file of listed.files) {
    if (text.length > 24_000) break;
    if (paths && !paths.includes(file.path)) continue;
    const shown = await diff(scope, view, file.path, pullRequestBase, github);
    text += "text" in shown ? shown.text : `${file.status} ${file.path}: no text diff\n`;
  }
  return text;
}
