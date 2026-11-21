import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, githubRemote, repository, unbornRepository } from "./git-fixture.ts";
import { commit } from "../src/daemon/commit.ts";
import { snapshot } from "../src/daemon/changes.ts";
import type { Gh } from "../src/daemon/github.ts";

const pull = { id: "PR_1", number: 3, url: "https://github.com/test/repo/pull/3", title: "Old", baseRefName: "main", state: "CLOSED", isDraft: false, reviewDecision: null, updatedAt: "2025-01-01", closedAt: "2025-01-02", headRepository: { id: "R_repo" }, commits: { nodes: [] }, reviewThreads: { nodes: [] } };
let pulls: unknown[] = [];
const github: Gh = async (_scope, args) => {
  if (args[0] === "auth") return "";
  if (args[0] === "repo") return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: false, parent: null });
  return JSON.stringify({ data: { repository: { pullRequests: { nodes: pulls } } } });
};

let root: string;
let repo: string;
let bare: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  environment = { ...process.env };
  pulls = [];
  root = mkdtempSync(join(tmpdir(), "flow-commit-"));
  repo = repository(root, "repo", ["feature"]);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  bare = githubRemote(root, repo);
});
afterEach(() => {
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string) {
  writeFileSync(join(repo, path), content);
}
function status(): string {
  return git(repo, "status", "--porcelain=v1", "--untracked-files=all");
}
function committed(): string[] {
  return git(repo, "diff-tree", "-r", "--name-only", "--no-commit-id", "--root", "HEAD").trim().split("\n");
}
async function commitPaths(paths: string[], options: { branch?: string; message?: string; fingerprint?: string } = {}) {
  const fingerprint = options.fingerprint ?? (await snapshot(repo)).fingerprint;
  return commit(repo, { fingerprint, paths, message: options.message ?? "Add work", ...(options.branch ? { branch: options.branch } : {}) }, github);
}
function hook(name: string, script: string) {
  const path = join(repo, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

it("commits only the selected files and keeps unselected staged and modified files", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("README.md", "selected\n");
  write("other.txt", "other\n");
  git(repo, "add", "other.txt");
  git(repo, "commit", "--quiet", "-m", "other");
  write("other.txt", "modified\n");
  write("staged.txt", "staged\n");
  git(repo, "add", "staged.txt");
  const id = await commitPaths(["README.md"]);
  assert.equal(git(repo, "rev-parse", "HEAD").trim(), id);
  assert.deepEqual(committed(), ["README.md"]);
  assert.equal(status(), " M other.txt\nA  staged.txt\n");
  assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "Add work");
});

it("commits selected untracked, deleted and partly staged files from the working tree", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("partly.txt", "one\n");
  git(repo, "add", "partly.txt");
  git(repo, "commit", "--quiet", "-m", "partly");
  write("partly.txt", "two\n");
  git(repo, "add", "partly.txt");
  write("partly.txt", "three\n");
  write("new.txt", "new\n");
  write("left.txt", "left\n");
  unlinkSync(join(repo, "README.md"));
  await commitPaths(["partly.txt", "new.txt", "README.md"]);
  assert.deepEqual(committed().sort(), ["README.md", "new.txt", "partly.txt"]);
  assert.equal(git(repo, "show", "HEAD:partly.txt"), "three\n");
  assert.equal(git(repo, "show", "HEAD:new.txt"), "new\n");
  assert.equal(status(), "?? left.txt\n");
});

it("commits file names with spaces and a leading dash", async () => {
  git(repo, "switch", "--quiet", "feature");
  mkdirSync(join(repo, "dir with space"));
  write("dir with space/ä b.txt", "a\n");
  write("-n", "dash\n");
  write("*", "star\n");
  write("x", "x\n");
  await commitPaths(["dir with space/ä b.txt", "-n", "*"]);
  assert.deepEqual(git(repo, "-c", "core.quotePath=false", "diff-tree", "-r", "--name-only", "--no-commit-id", "HEAD").trim().split("\n").sort(), ["*", "-n", "dir with space/ä b.txt"]);
  assert.equal(status(), "?? x\n");
});

it("creates a new branch from the default branch and refuses a commit there without one", async () => {
  write("new.txt", "new\n");
  await assert.rejects(commitPaths(["new.txt"]), /new branch name/);
  assert.equal(git(repo, "rev-list", "--count", "main").trim(), "1");
  for (const name of ["-x", "main", "feature", "@{-1}", "bad name"]) await assert.rejects(commitPaths(["new.txt"], { branch: name }), Error, name);
  await commitPaths(["new.txt"], { branch: "feat/new" });
  assert.equal(git(repo, "branch", "--show-current").trim(), "feat/new");
  assert.equal(git(repo, "rev-list", "--count", "main").trim(), "1");
  assert.deepEqual(committed(), ["new.txt"]);
});

it("refuses a new branch name that exists on the remote", async () => {
  git(repo, "push", "--quiet", bare, "main:refs/heads/taken");
  write("new.txt", "new\n");
  await assert.rejects(commitPaths(["new.txt"], { branch: "taken" }), /already exists/);
  assert.equal(git(repo, "branch", "--show-current").trim(), "main");
});

it("creates a new branch from a detached HEAD", async () => {
  git(repo, "switch", "--quiet", "--detach", "feature");
  write("new.txt", "new\n");
  await assert.rejects(commitPaths(["new.txt"]), /new branch name/);
  await commitPaths(["new.txt"], { branch: "feat/detached" });
  assert.equal(git(repo, "branch", "--show-current").trim(), "feat/detached");
});

it("commits on any branch when no GitHub remote resolves", async () => {
  git(repo, "remote", "set-url", "origin", bare);
  write("new.txt", "new\n");
  await commitPaths(["new.txt"]);
  assert.equal(git(repo, "branch", "--show-current").trim(), "main");
  assert.deepEqual(committed(), ["new.txt"]);
});

it("makes the first commit in a repository with no commits", async () => {
  const empty = unbornRepository(root, "empty");
  git(empty, "config", "user.name", "Test");
  git(empty, "config", "user.email", "test@example.com");
  writeFileSync(join(empty, "first.txt"), "first\n");
  writeFileSync(join(empty, "later.txt"), "later\n");
  const id = await commit(empty, { fingerprint: (await snapshot(empty)).fingerprint, paths: ["first.txt"], message: "First" }, github);
  assert.equal(git(empty, "rev-parse", "HEAD").trim(), id);
  assert.equal(git(empty, "status", "--porcelain=v1", "--untracked-files=all"), "?? later.txt\n");
});

it("renames a branch only when it has no pull request, remote branch or stack registration", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("new.txt", "new\n");
  await commitPaths(["new.txt"], { branch: "feat/renamed" });
  assert.equal(git(repo, "branch", "--show-current").trim(), "feat/renamed");
  assert.deepEqual(committed(), ["new.txt"]);
  for (const protection of ["tracking", "remote", "stack", "pr"]) {
    git(repo, "switch", "--quiet", "-c", `guarded-${protection}`);
    if (protection === "tracking") git(repo, "update-ref", `refs/remotes/origin/guarded-${protection}`, "HEAD");
    if (protection === "remote") git(repo, "push", "--quiet", bare, `HEAD:refs/heads/guarded-${protection}`);
    if (protection === "stack") writeFileSync(join(repo, ".git", "gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: `guarded-${protection}` }] }] }));
    if (protection === "pr") pulls = [pull];
    write("more.txt", protection);
    await assert.rejects(commitPaths(["more.txt"], { branch: `feat/${protection}` }), /cannot be renamed/);
    assert.equal(git(repo, "branch", "--show-current").trim(), `guarded-${protection}`);
    await commitPaths(["more.txt"], { branch: `guarded-${protection}` });
  }
});

it("commits a submodule pointer change as an ordinary entry", async () => {
  const child = repository(root, "child");
  git(repo, "switch", "--quiet", "feature");
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, "sub");
  git(repo, "commit", "--quiet", "-m", "add submodule");
  writeFileSync(join(repo, "sub", "next.txt"), "next\n");
  git(join(repo, "sub"), "add", "next.txt");
  git(join(repo, "sub"), "commit", "--quiet", "-m", "next");
  const pointer = git(join(repo, "sub"), "rev-parse", "HEAD").trim();
  await commitPaths(["sub"]);
  assert.match(git(repo, "ls-tree", "HEAD", "sub"), new RegExp(`^160000 commit ${pointer}\tsub`));
});

it("refuses a commit when the changes differ from the list that was read", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("new.txt", "first\n");
  const { fingerprint } = await snapshot(repo);
  write("new.txt", "other\n");
  await assert.rejects(commitPaths(["new.txt"], { fingerprint }), /Read the list again/);
  await assert.rejects(commitPaths(["missing.txt"]), /not in the list/);
  assert.equal(git(repo, "rev-list", "--count", "HEAD").trim(), "1");
});

it("runs hooks and reports a hook that changed the committed files", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("new.txt", "new\n");
  hook("pre-commit", "echo 'hook refused' >&2\nexit 1");
  await assert.rejects(commitPaths(["new.txt"]), /hook refused/);
  hook("pre-commit", "echo extra > extra.txt\ngit add extra.txt");
  await assert.rejects(commitPaths(["new.txt"]), /hooks changed the committed files/);
});

it("reports a hook that changed the commit parent", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("feature.txt", "feature\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "--quiet", "-m", "feature");
  write("new.txt", "new\n");
  hook("post-commit", 'replacement=$(git commit-tree HEAD^{tree} -p HEAD^ -p main -m replacement)\ngit update-ref HEAD "$replacement"');
  await assert.rejects(commitPaths(["new.txt"]), /hooks changed the commit parent/);
});

it("refuses a commit during a conflict or a Git operation", async () => {
  git(repo, "switch", "--quiet", "feature");
  write("README.md", "feature\n");
  git(repo, "commit", "--quiet", "-am", "feature");
  git(repo, "switch", "--quiet", "-c", "other", "main");
  write("README.md", "other\n");
  git(repo, "commit", "--quiet", "-am", "other");
  assert.throws(() => git(repo, "merge", "--quiet", "feature"));
  await assert.rejects(commitPaths(["README.md"]), /Resolve the merge conflicts/);
  git(repo, "merge", "--abort");
  write("new.txt", "new\n");
  mkdirSync(join(repo, ".git", "rebase-merge"));
  await assert.rejects(commitPaths(["new.txt"]), /Finish the current Git operation/);
});
