import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { head, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import { gh, type Gh } from "./github.ts";
import { resolveRepository } from "./repository.ts";
import { localStack, stackParent } from "./stack-metadata.ts";
import type { GitFile } from "../protocol/publish.ts";
import type { ChangesView, GitChanges, GitDiff } from "../protocol/git.ts";

const DIFF_LIMIT = 400_000;

export async function git(scope: string, args: string[], write = false): Promise<string> {
  const result = await run(scope, args, write ? GIT_WRITE_TIMEOUT_MS : GIT_READ_TIMEOUT_MS);
  if (!result.ok) {
    if (result.failure.message.includes("ENOENT")) throw new Error("Git is missing. Install git on the Session Host.");
    throw new Error(`Git ${result.failure.attempted} failed: ${result.failure.message}`);
  }
  return result.value;
}

export async function files(scope: string): Promise<GitFile[]> {
  const raw = await git(scope, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  return raw.split("\0").filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
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

async function branchBase(scope: string, pullRequestBase: string | undefined, github: Gh): Promise<string> {
  const current = await head(scope);
  const branch = current.ok && !current.value.detached ? current.value.name : undefined;
  const repository = await resolveRepository(scope, branch, github);
  const stack = branch === undefined ? undefined : await localStack(scope, branch);
  const parent = stack && stackParent(stack, branch!);
  const name = pullRequestBase ?? parent ?? repository.base.defaultBranch;
  const ref = await baseRef(scope, repository.remote, name, name === parent);
  if (!ref) throw new Error(`The base branch ${name} is not known locally. Fetch ${name} from ${repository.remote} to show the branch changes.`);
  return ref;
}

export async function changes(scope: string, view: ChangesView, pullRequestBase?: string, github: Gh = gh): Promise<GitChanges> {
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
  if (stat.size > DIFF_LIMIT) return { tooLarge: true };
  const content = await readFile(full);
  if (content.includes(0)) return { binary: true };
  return { text: added(path, content.toString("utf8")) };
}

export async function diff(scope: string, view: ChangesView, path: string, pullRequestBase?: string, github: Gh = gh): Promise<GitDiff> {
  const base = view === "branch" ? await branchBase(scope, pullRequestBase, github) : undefined;
  const listed = base ? await rangeFiles(scope, base) : await files(scope);
  const file = listed.find(item => item.path === path);
  if (!file) throw new Error("This file is not in the list of changes. Read the list again.");
  if (file.status === "??") return untracked(scope, path);
  const range = base ? `${base}...HEAD` : "HEAD";
  const numstat = await git(scope, ["--literal-pathspecs", "diff", "--numstat", range, "--", path]);
  if (numstat.startsWith("-\t-\t")) return { binary: true };
  const result = await run(scope, ["--literal-pathspecs", "diff", "--no-ext-diff", range, "--", path], GIT_READ_TIMEOUT_MS);
  if (!result.ok) {
    if (result.failure.message.includes("maxBuffer")) return { tooLarge: true };
    throw new Error(`Git ${result.failure.attempted} failed: ${result.failure.message}`);
  }
  return result.value.length > DIFF_LIMIT ? { tooLarge: true } : { text: result.value };
}
