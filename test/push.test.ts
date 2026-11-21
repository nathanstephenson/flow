import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, githubRemote, repository } from "./git-fixture.ts";
import { push, pushState } from "../src/daemon/push.ts";
import { readLocal } from "../src/daemon/git-state.ts";
import type { Gh } from "../src/daemon/github.ts";

const github: Gh = async (_scope, args) => {
  if (args[0] === "auth") return "";
  return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: false, parent: null });
};

let root: string;
let repo: string;
let bare: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  environment = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "flow-push-"));
  repo = repository(root, "repo", ["feature"]);
  bare = githubRemote(root, repo);
  git(repo, "switch", "--quiet", "feature");
});
afterEach(() => {
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});

function work(message: string) {
  writeFileSync(join(repo, `${message}.txt`), message);
  git(repo, "add", "--", `${message}.txt`);
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}
const remote = () => git(bare, "rev-parse", "refs/heads/feature").trim();

async function diverge() {
  work("shared");
  await push(repo, { head: git(repo, "rev-parse", "HEAD").trim() }, github);
  const replaced = work("remote work");
  git(repo, "push", "--quiet", "origin", "feature");
  git(repo, "reset", "--quiet", "--hard", "HEAD~1");
  git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD");
  return { replaced, head: work("rebased") };
}

it("pushes the branch to the push remote, sets the upstream and clears ahead", async () => {
  const head = work("one");
  assert.deepEqual(await pushState(repo, github), { branch: "feature", head, replaced: [] });
  await push(repo, { head }, github);
  assert.equal(remote(), head);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim(), "origin/feature");
  const local = await readLocal(repo);
  assert.equal(local?.upstream, true);
  assert.equal(local?.ahead, 0);
  assert.deepEqual(await pushState(repo, github), { branch: "feature", head, remote: head, replaced: [] });
});

it("refuses a push when HEAD is not the commit the pane showed", async () => {
  const shown = work("one");
  work("two");
  await assert.rejects(push(repo, { head: shown }, github), /HEAD moved/);
  assert.throws(() => remote());
});

it("never pushes the default branch or a detached HEAD", async () => {
  git(repo, "switch", "--quiet", "main");
  const head = git(repo, "rev-parse", "HEAD").trim();
  await assert.rejects(pushState(repo, github), /default branch/);
  await assert.rejects(push(repo, { head }, github), /default branch/);
  git(repo, "switch", "--quiet", "--detach");
  await assert.rejects(push(repo, { head }, github), /detached/);
  assert.equal(git(bare, "for-each-ref"), "");
});

it("lists the remote commits a push would replace", async () => {
  const { replaced, head } = await diverge();
  const state = await pushState(repo, github);
  assert.equal(state.head, head);
  assert.equal(state.remote, replaced);
  assert.deepEqual(state.replaced, [`${replaced.slice(0, 7)} remote work`]);
});

it("refuses a diverged push without replace and replaces the commit the pane showed", async () => {
  const { replaced, head } = await diverge();
  await assert.rejects(push(repo, { head }, github), /rejected|non-fast-forward/);
  assert.equal(remote(), replaced);
  await push(repo, { head, replace: replaced }, github);
  assert.equal(remote(), head);
});

it("refuses a replacement when the remote moved after the preview", async () => {
  const { replaced, head } = await diverge();
  const other = join(root, "other");
  git(root, "clone", "--quiet", "--branch", "feature", bare, other);
  writeFileSync(join(other, "late.txt"), "late");
  git(other, "add", "late.txt");
  git(other, "commit", "--quiet", "-m", "late");
  git(other, "push", "--quiet", "origin", "feature");
  const moved = remote();
  await assert.rejects(push(repo, { head, replace: replaced }, github), /stale|rejected/);
  assert.equal(remote(), moved);
  await assert.rejects(push(repo, { head, replace: "not a commit" }, github), /Invalid/);
});
