import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readlink, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { head, isRepository, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { GitFile, GitStatus, PublishInput, PublishResult, PullRequest } from "../protocol/publish.ts";

const exec = promisify(execFile);
export type Gh = (scope: string, args: string[]) => Promise<string>;

export const gh: Gh = async (scope, args) => {
  try {
    return (await exec("gh", args, {
      cwd: scope,
      timeout: GIT_WRITE_TIMEOUT_MS,
      maxBuffer: 2 << 20,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    })).stdout;
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string; message?: string };
    if (failure.code === "ENOENT") throw new Error("GitHub CLI is missing. Install gh on the Session Host.");
    const detail = failure.stderr?.trim() || failure.message || "Unknown error";
    const requestFailed = /HTTP (?:429|5\d\d)|connection|timed? out|network|TLS|certificate|could not resolve/i.test(detail);
    if (failure.code === 4 || (args[0] === "auth" && !requestFailed)) {
      throw new Error(`GitHub authentication failed. Run gh auth login on the Session Host. ${detail}`);
    }
    throw new Error(`GitHub request failed: ${detail}`);
  }
};

async function git(scope: string, args: string[], write = false): Promise<string> {
  const result = await run(scope, args, write ? GIT_WRITE_TIMEOUT_MS : GIT_READ_TIMEOUT_MS);
  if (!result.ok) {
    if (result.failure.message.includes("ENOENT")) throw new Error("Git is missing. Install git on the Session Host.");
    throw new Error(`Git ${result.failure.attempted} failed: ${result.failure.message}`);
  }
  return result.value;
}

export type PublishSnapshot = {
  fingerprint: string;
  contentFingerprint: string;
  unstaged: boolean;
  files: GitFile[];
  branch: string;
  commit: string;
};
export type PublishTarget = { remote: string; url: string; repo: string; defaultBranch: string; pr?: PullRequest };

async function files(scope: string): Promise<GitFile[]> {
  const raw = await git(scope, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  return raw.split("\0").filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

export async function snapshot(scope: string): Promise<PublishSnapshot & { input: string }> {
  if (!isRepository(scope)) throw new Error("This Scope is not a Git repository.");
  const branch = await head(scope);
  if (!branch.ok) throw new Error(branch.failure.message.includes("ENOENT") ? "Git is missing. Install git on the Session Host." : branch.failure.message);
  if (branch.value.detached) throw new Error("HEAD is detached. Switch to a branch before publishing.");
  const commit = await run(scope, ["rev-parse", "--verify", "HEAD"], GIT_READ_TIMEOUT_MS);
  if (!commit.ok) throw new Error("This branch has no commits. Make the first commit before publishing.");
  const changed = await files(scope);
  if (changed.some((file) => file.status.includes("U") || ["AA", "DD"].includes(file.status))) {
    throw new Error("Resolve merge conflicts before publishing.");
  }
  const index = await git(scope, ["ls-files", "--stage", "-z"]);
  if (index.split("\0").some((entry) => entry.startsWith("160000 "))) {
    throw new Error("Publishing repositories with submodules is not supported. Use Git directly.");
  }
  for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
    const active = await run(scope, ["rev-parse", "--verify", "-q", operation], GIT_READ_TIMEOUT_MS);
    if (active.ok) throw new Error("Finish the current Git operation before publishing.");
  }
  for (const operation of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const path = (await git(scope, ["rev-parse", "--git-path", operation])).trim();
    const active = await access(resolve(scope, path)).then(() => true, () => false);
    if (active) throw new Error("Finish the current Git operation before publishing.");
  }
  const staged = await git(scope, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]);
  const working = await git(scope, ["diff", "--binary", "--no-ext-diff", "--no-textconv"]);
  const content = createHash("sha256");
  let untracked = "";
  for (const file of [...changed].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = resolve(scope, file.path);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    content.update(JSON.stringify({ path: file.path, mode: stat?.mode, size: stat?.size }));
    if (!stat) continue;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Cannot publish this file type: ${file.path}`);
    if (stat.isSymbolicLink()) content.update(await readlink(path));
    else {
      let preview = "";
      for await (const chunk of createReadStream(path)) {
        content.update(chunk);
        if (file.status === "??" && preview.length < 4_000 && untracked.length < 8_000) preview += chunk.toString("utf8").slice(0, 4_000 - preview.length);
      }
      if (preview && !preview.includes("\0")) untracked += `\nUntracked ${JSON.stringify(file.path)}:\n${preview}`.slice(0, 8_000 - untracked.length);
    }
  }
  const contentFingerprint = content.digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify({ commit: commit.value, changed, index, staged, working, contentFingerprint })).digest("hex");
  return {
    fingerprint, contentFingerprint, unstaged: working !== "", files: changed, branch: branch.value.name, commit: commit.value.trim(),
    input: `${JSON.stringify(changed)}\n${staged}\n${working}\n${untracked}`,
  };
}

export async function target(scope: string, branch: string, github: Gh = gh): Promise<PublishTarget> {
  const remotes = (await git(scope, ["remote"])).trim().split("\n").filter(Boolean);
  if (remotes.length === 0) throw new Error("No remote is configured. Add a GitHub remote before publishing.");
  if (remotes.length !== 1) throw new Error("Publish requires exactly one remote. Select and publish the remote with Git directly.");
  const remote = remotes[0]!;
  const urls = (await git(scope, ["remote", "get-url", "--all", remote])).trim().split("\n");
  const pushes = (await git(scope, ["remote", "get-url", "--push", "--all", remote])).trim().split("\n");
  if (urls.length !== 1 || pushes.length !== 1 || pushes[0] !== urls[0]) {
    throw new Error("Fetch and push remotes differ or are ambiguous. Publish with Git directly.");
  }
  const url = urls[0]!;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error("This remote is not a supported github.com repository URL.");
  const repo = match[1]!;
  await github(scope, ["auth", "status", "--hostname", "github.com"]);
  const info = JSON.parse(await github(scope, ["repo", "view", repo, "--json", "defaultBranchRef,isFork"])) as { defaultBranchRef?: { name: string }; isFork: boolean };
  if (info.isFork) throw new Error("Fork publishing is not supported. Publish with gh directly to select the base repository.");
  if (!info.defaultBranchRef?.name) throw new Error("GitHub has no default branch. Create it before publishing.");
  const prs = JSON.parse(await github(scope, ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,title,isDraft,reviewDecision,statusCheckRollup,headRepository"])) as (PullRequest & { headRepository?: { nameWithOwner?: string } })[];
  if (prs.length > 1) throw new Error("More than one pull request matches this branch. Publish with gh directly.");
  const pr = prs[0];
  if (pr && branch === info.defaultBranchRef.name) throw new Error("The default branch already heads a pull request. Publish with gh directly to select the intended branch.");
  if (pr) pr.statusCheckRollup ??= [];
  if (pr && pr.headRepository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error("The pull request uses a different head repository. Publish with gh directly.");
  }
  return { remote, url, repo, defaultBranch: info.defaultBranchRef.name, ...(pr ? { pr } : {}) };
}

export async function branchChanges(scope: string, destination: PublishTarget): Promise<{ files: GitFile[]; commits: string[]; input: string }> {
  let base = `refs/remotes/${destination.remote}/${destination.defaultBranch}`;
  const remote = await run(scope, ["rev-parse", "--verify", base], GIT_READ_TIMEOUT_MS);
  if (!remote.ok) base = `refs/heads/${destination.defaultBranch}`;
  const known = await run(scope, ["rev-parse", "--verify", base], GIT_READ_TIMEOUT_MS);
  if (!known.ok) throw new Error("Fetch the default branch before publishing so its changes can be reviewed.");
  const range = `${base}...HEAD`;
  const raw = (await git(scope, ["diff", "--name-status", "-z", "--no-renames", range, "--"])).split("\0").filter(Boolean);
  const files: GitFile[] = [];
  for (let index = 0; index < raw.length; index += 2) files.push({ status: raw[index]!, path: raw[index + 1]! });
  const commits = (await git(scope, ["log", "--format=%h %s", `${base}..HEAD`, "--"])).trim().split("\n").filter(Boolean);
  const diff = await git(scope, ["diff", "--binary", "--no-ext-diff", "--no-textconv", range, "--"]);
  return { files, commits, input: `${commits.join("\n")}\n${diff}` };
}

export async function gitStatus(scope: string, github: Gh = gh): Promise<GitStatus> {
  if (!isRepository(scope)) return { repository: false, files: [] };
  const status: GitStatus = { repository: true, files: [] };
  try {
    status.files = await files(scope);
    const branch = await head(scope);
    if (!branch.ok) throw new Error(branch.failure.message);
    status.branch = branch.value;
    if (branch.value.detached) throw new Error("HEAD is detached. Switch to a branch before publishing.");
    const destination = await target(scope, branch.value.name, github);
    if (destination.pr) status.pr = destination.pr;
  } catch (error) {
    status.problem = error instanceof Error ? error.message : String(error);
  }
  return status;
}

export async function publish(scope: string, reviewed: PublishSnapshot, destination: PublishTarget, input: PublishInput, github: Gh = gh): Promise<PublishResult> {
  const result: PublishResult = { pushed: false };
  try {
    const current = await snapshot(scope);
    if (current.branch !== reviewed.branch || current.fingerprint !== reviewed.fingerprint) throw new Error("Reviewed changes have changed. Open Publish again.");
    const freshTarget = await target(scope, current.branch, github);
    if (freshTarget.remote !== destination.remote || freshTarget.url !== destination.url || freshTarget.repo !== destination.repo || freshTarget.defaultBranch !== destination.defaultBranch || freshTarget.pr?.number !== destination.pr?.number) throw new Error("The remote or pull request has changed. Open Publish again.");
    if (typeof input.commitMessage !== "string" || typeof input.title !== "string" || typeof input.body !== "string" || !input.title.trim() || (current.files.length > 0 && !input.commitMessage.trim())) {
      throw new Error("A commit message and pull request title are required.");
    }
    const checked = await snapshot(scope);
    if (checked.branch !== current.branch || checked.fingerprint !== current.fingerprint) throw new Error("Reviewed changes have changed. Open Publish again.");
    let branch = current.branch;
    if (branch === destination.defaultBranch) {
      if (typeof input.branch !== "string" || !input.branch.trim() || input.branch.startsWith("-") || input.branch === destination.defaultBranch) {
        throw new Error("Enter a new feature branch name before publishing from the default branch.");
      }
      await git(scope, ["check-ref-format", "--branch", input.branch]);
      const refs = JSON.parse(await github(scope, ["api", `repos/${destination.repo}/git/matching-refs/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`])) as { ref: string }[];
      if (refs.some((ref) => ref.ref === `refs/heads/${input.branch}`)) throw new Error("That feature branch already exists on GitHub. Choose a new branch name or switch to the existing branch before publishing.");
      const beforeSwitch = await snapshot(scope);
      if (beforeSwitch.branch !== reviewed.branch || beforeSwitch.fingerprint !== reviewed.fingerprint) throw new Error("Reviewed changes have changed. Open Publish again.");
      await git(scope, ["switch", "-c", input.branch], true);
      branch = input.branch;
      result.branch = branch;
      const afterSwitch = await snapshot(scope);
      if (afterSwitch.fingerprint !== reviewed.fingerprint) {
        throw new Error("The branch was created, but its changes differ after checkout hooks. Open Publish again.");
      }
    }
    if (current.files.length > 0) {
      await git(scope, ["add", "--all", "--", "."], true);
      const tree = (await git(scope, ["write-tree"])).trim();
      const staged = await snapshot(scope);
      if (staged.unstaged || staged.contentFingerprint !== reviewed.contentFingerprint || staged.branch !== branch || staged.commit !== reviewed.commit) throw new Error("Changes moved while staging. Review the index and open Publish again.");
      await git(scope, ["commit", "-m", input.commitMessage], true);
      result.committed = (await git(scope, ["rev-parse", "HEAD"])).trim();
      if ((await git(scope, ["rev-parse", `${result.committed}^{tree}`])).trim() !== tree) throw new Error("Commit hooks changed the committed files. Review the commit before pushing.");
      if ((await git(scope, ["show", "--no-patch", "--format=%P", result.committed])).trim() !== reviewed.commit) throw new Error("The commit parents changed. Review the commit before pushing.");
      if ((await files(scope)).length > 0) throw new Error("Commit completed, but hooks or another process left changes. Review them before pushing.");
    }
    const finalHead = await head(scope);
    if (!finalHead.ok || finalHead.value.detached || finalHead.value.name !== branch) throw new Error("The branch changed before pushing. Open Publish again.");
    await git(scope, ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "--no-follow-tags", destination.url, `${result.committed ?? reviewed.commit}:refs/heads/${branch}`], true);
    result.pushed = true;
    if (destination.pr) result.url = destination.pr.url;
    else {
      result.url = (await github(scope, ["pr", "create", "--repo", destination.repo, "--base", destination.defaultBranch, "--head", branch, "--title", input.title, "--body", input.body, ...(input.ready === true ? [] : ["--draft"])] )).trim();
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
