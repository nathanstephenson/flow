import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { canNameBranch } from "./changes.ts";
import { readStatus } from "./git-state.ts";
import { gh, type Gh } from "./github.ts";
import { remoteHead } from "./push.ts";
import { git, localRepository, resolvePullRequest, resolveRepository, type LocalRepository } from "./repository.ts";
import type { CommitInput } from "../protocol/git.ts";

async function refuseOperation(scope: string): Promise<void> {
  if ((await readStatus(scope)).files.some(file => file.status.includes("U") || ["AA", "DD"].includes(file.status))) throw new Error("Resolve the merge conflicts before you commit.");
  for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if ((await run(scope, ["rev-parse", "--verify", "-q", operation], GIT_READ_TIMEOUT_MS)).ok) throw new Error("Finish the current Git operation before you commit.");
  }
  for (const operation of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const path = (await git(scope, ["rev-parse", "--git-path", operation])).trim();
    if (await access(resolve(scope, path)).then(() => true, () => false)) throw new Error("Finish the current Git operation before you commit.");
  }
}

async function refuseBranchName(scope: string, name: string, repository: LocalRepository | undefined): Promise<void> {
  if (name.startsWith("-") || name.includes("@{") || repository?.defaultBranches.includes(name)) throw new Error(`${name} is not a valid new branch name.`);
  await git(scope, ["check-ref-format", "--branch", name]);
  if ((await run(scope, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], GIT_READ_TIMEOUT_MS)).ok) throw new Error(`The branch ${name} already exists. Enter a new name.`);
  if (repository && await remoteHead(scope, repository.remote, name)) throw new Error(`The branch ${name} already exists on ${repository.remote}. Enter a new name.`);
}

async function renameAllowed(scope: string, branch: string, repository: LocalRepository | undefined, github: Gh): Promise<boolean> {
  if (!repository?.github) return false;
  const pullRequest = await resolvePullRequest(scope, await resolveRepository(scope, branch, github), branch, github);
  return await canNameBranch(scope, branch, repository.remote, pullRequest !== undefined) && !await remoteHead(scope, repository.remote, branch);
}

export async function commit(scope: string, input: CommitInput, github: Gh = gh): Promise<string> {
  if (typeof input.message !== "string" || !input.message.trim()) throw new Error("Enter a commit message.");
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.some(path => typeof path !== "string")) throw new Error("Select at least one file to commit.");
  await refuseOperation(scope);
  const reviewed = await readStatus(scope);
  const changed = "The changes changed after the list was read. Read the list again.";
  if (reviewed.fingerprint !== input.fingerprint) throw new Error(changed);
  const paths = new Set(input.paths);
  if ([...paths].some(path => !reviewed.files.some(file => file.path === path))) throw new Error("A selected file is not in the list of changes. Read the list again.");
  const branch = reviewed.local.branch;
  const repository = await localRepository(scope, branch);
  if (repository?.github && repository.defaultBranches.length === 0) throw new Error(`The default branch of ${repository.remote} is not known. Refresh when GitHub answers, or run git remote set-head ${repository.remote} --auto.`);
  const creating = branch === undefined || repository?.defaultBranches.includes(branch) === true;
  const name = typeof input.branch === "string" ? input.branch.trim() : "";
  if (creating && (!name || name === branch)) throw new Error(branch ? `${branch} is the default branch. Enter a new branch name.` : "HEAD is detached. Enter a new branch name.");
  if (name && name !== branch) {
    await refuseBranchName(scope, name, repository);
    if (!creating && !await renameAllowed(scope, branch!, repository, github)) throw new Error(`${branch} has a pull request, a remote branch or a stack registration, so it cannot be renamed.`);
    await git(scope, creating ? ["switch", "--quiet", "-c", name] : ["branch", "-m", name], true);
  }
  if ((await readStatus(scope)).fingerprint !== input.fingerprint) throw new Error(name && name !== branch ? `The branch ${name} is ready, but the changes changed. Read the list again.` : changed);
  const untracked = reviewed.files.filter(file => file.status === "??" && paths.has(file.path)).map(file => file.path);
  try {
    if (untracked.length > 0) await git(scope, ["--literal-pathspecs", "add", "--intent-to-add", "--", ...untracked], true);
    await git(scope, ["--literal-pathspecs", "commit", "--quiet", "-m", input.message, "--", ...paths], true);
  } catch (error) {
    if (untracked.length > 0) await run(scope, ["--literal-pathspecs", "rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...untracked], GIT_READ_TIMEOUT_MS);
    throw error;
  }
  const [created, ...parents] = (await git(scope, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" ");
  if (parents.join(" ") !== (reviewed.local.head ?? "")) throw new Error(`Commit ${created!.slice(0, 7)} was created, but its parent is not the commit that was read. Review the commit before you push.`);
  const committed = (await git(scope, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", "--root", "HEAD"])).split("\0").filter(Boolean);
  if (committed.length !== paths.size || committed.some(path => !paths.has(path))) throw new Error(`Commit ${created!.slice(0, 7)} was created, but it does not contain exactly the selected files. Review the commit before you push.`);
  return created!;
}
