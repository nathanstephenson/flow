import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { head, run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { canNameBranch, files, git, snapshot } from "./changes.ts";
import { gh, type Gh } from "./github.ts";
import { remoteHead } from "./push.ts";
import { resolvePullRequest, resolveRepository, type Repository } from "./repository.ts";
import type { CommitInput } from "../protocol/git.ts";

async function refuseOperation(scope: string): Promise<void> {
  if ((await files(scope)).some(file => file.status.includes("U") || ["AA", "DD"].includes(file.status))) throw new Error("Resolve the merge conflicts before you commit.");
  for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if ((await run(scope, ["rev-parse", "--verify", "-q", operation], GIT_READ_TIMEOUT_MS)).ok) throw new Error("Finish the current Git operation before you commit.");
  }
  for (const operation of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const path = (await git(scope, ["rev-parse", "--git-path", operation])).trim();
    if (await access(resolve(scope, path)).then(() => true, () => false)) throw new Error("Finish the current Git operation before you commit.");
  }
}

async function refuseBranchName(scope: string, name: string, repository: Repository | undefined): Promise<void> {
  if (name.startsWith("-") || name.includes("@{") || name === repository?.base.defaultBranch) throw new Error(`${name} is not a valid new branch name.`);
  await git(scope, ["check-ref-format", "--branch", name]);
  if ((await run(scope, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], GIT_READ_TIMEOUT_MS)).ok) throw new Error(`The branch ${name} already exists. Enter a new name.`);
  if (repository && await remoteHead(scope, repository.remote, name)) throw new Error(`The branch ${name} already exists on ${repository.remote}. Enter a new name.`);
}

async function renameAllowed(scope: string, branch: string, repository: Repository | undefined, github: Gh): Promise<boolean> {
  if (!repository) return false;
  const pullRequest = await resolvePullRequest(scope, repository, branch, github);
  return await canNameBranch(scope, branch, repository.remote, pullRequest !== undefined) && !await remoteHead(scope, repository.remote, branch);
}

export async function commit(scope: string, input: CommitInput, github: Gh = gh): Promise<string> {
  if (typeof input.message !== "string" || !input.message.trim()) throw new Error("Enter a commit message.");
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.some(path => typeof path !== "string")) throw new Error("Select at least one file to commit.");
  await refuseOperation(scope);
  const reviewed = await snapshot(scope);
  if (reviewed.fingerprint !== input.fingerprint) throw new Error("The changes changed after the list was read. Read the list again.");
  const paths = new Set(input.paths);
  if ([...paths].some(path => !reviewed.files.some(file => file.path === path))) throw new Error("A selected file is not in the list of changes. Read the list again.");
  const current = await head(scope);
  if (!current.ok) throw new Error(current.failure.message);
  const branch = current.value.detached ? undefined : current.value.name;
  const repository = await resolveRepository(scope, branch, github).catch(() => undefined);
  const creating = branch === undefined || branch === repository?.base.defaultBranch;
  const name = typeof input.branch === "string" ? input.branch.trim() : "";
  if (creating && (!name || name === branch)) throw new Error(branch ? `${branch} is the default branch. Enter a new branch name.` : "HEAD is detached. Enter a new branch name.");
  if (name && name !== branch) {
    await refuseBranchName(scope, name, repository);
    if (!creating && !await renameAllowed(scope, branch!, repository, github)) throw new Error(`${branch} has a pull request, a remote branch or a stack registration, so it cannot be renamed.`);
    await git(scope, creating ? ["switch", "--quiet", "-c", name] : ["branch", "-m", name], true);
    if ((await snapshot(scope)).state !== reviewed.state) throw new Error(`The branch ${name} is ready, but checkout hooks changed the files. Read the list again.`);
  }
  const untracked = reviewed.files.filter(file => file.status === "??" && paths.has(file.path)).map(file => file.path);
  if (untracked.length > 0) await git(scope, ["--literal-pathspecs", "add", "--intent-to-add", "--", ...untracked], true);
  await git(scope, ["--literal-pathspecs", "commit", "--quiet", "-m", input.message, "--", ...paths], true);
  const [created, ...parents] = (await git(scope, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" ");
  if (parents.join(" ") !== (reviewed.commit ?? "")) throw new Error(`Commit ${created!.slice(0, 7)} is made, but Git hooks changed the commit parent. Examine the commit before you push.`);
  const committed = (await git(scope, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", "--root", "HEAD"])).split("\0").filter(Boolean);
  if (committed.length !== paths.size || committed.some(path => !paths.has(path))) throw new Error(`Commit ${created!.slice(0, 7)} is made, but Git hooks changed the committed files. Examine the commit before you push.`);
  return created!;
}
