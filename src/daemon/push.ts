import { head, run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { git } from "./changes.ts";
import { gh, type Gh } from "./github.ts";
import { resolveRepository, type Repository } from "./repository.ts";
import type { PushInput, PushState } from "../protocol/git.ts";

const credentials = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export async function remoteHead(scope: string, remote: string, branch: string): Promise<string | undefined> {
  const listed = await git(scope, [...credentials, "ls-remote", "--heads", remote, `refs/heads/${branch}`], true);
  return listed.split("\n").map(line => line.split("\t")).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
}

export async function pushTarget(scope: string, github: Gh): Promise<{ branch: string; head: string; repository: Repository }> {
  const current = await head(scope);
  if (!current.ok) throw new Error(current.failure.message);
  if (current.value.detached) throw new Error("HEAD is detached. Commit on a new branch first.");
  const branch = current.value.name;
  const repository = await resolveRepository(scope, branch, github);
  if (branch === repository.base.defaultBranch) throw new Error(`${branch} is the default branch. Flow does not push or open pull requests from it.`);
  const commit = await run(scope, ["rev-parse", "--verify", "--quiet", "HEAD"], GIT_READ_TIMEOUT_MS);
  if (!commit.ok) throw new Error("This branch has no commits. Commit first.");
  return { branch, head: commit.value.trim(), repository };
}

export async function pushState(scope: string, github: Gh = gh): Promise<PushState> {
  const { branch, head, repository } = await pushTarget(scope, github);
  const remote = await remoteHead(scope, repository.remote, branch);
  if (!remote) return { branch, head, replaced: [] };
  if (!(await run(scope, ["cat-file", "-e", `${remote}^{commit}`], GIT_READ_TIMEOUT_MS)).ok) {
    await git(scope, [...credentials, "fetch", "--quiet", "--no-tags", repository.remote, `refs/heads/${branch}`], true);
  }
  const replaced = (await git(scope, ["log", "--no-color", "--format=%h %s", `HEAD..${remote}`, "--"])).split("\n").filter(Boolean);
  return { branch, head, remote, replaced };
}

export async function push(scope: string, input: PushInput, github: Gh = gh): Promise<void> {
  if (input.replace !== undefined && !/^[0-9a-f]{40,64}$/.test(input.replace)) throw new Error("Invalid remote commit ID.");
  const { branch, head, repository } = await pushTarget(scope, github);
  if (head !== input.head) throw new Error("HEAD moved after the push state was read. Read it again.");
  const lease = input.replace ? [`--force-with-lease=refs/heads/${branch}:${input.replace}`] : [];
  await git(scope, [...credentials, "push", "--quiet", "--no-follow-tags", "--set-upstream", ...lease, repository.remote, `refs/heads/${branch}:refs/heads/${branch}`], true);
}
