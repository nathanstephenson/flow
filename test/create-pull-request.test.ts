import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, githubRemote, repository } from "./git-fixture.ts";
import { createPullRequest } from "../src/daemon/pull-request.ts";
import type { Gh } from "../src/daemon/github.ts";

const open = { id: "PR_1", number: 5, url: "https://github.com/test/repo/pull/5", title: "Open", baseRefName: "main", state: "OPEN", isDraft: false, reviewDecision: null, updatedAt: "2025-01-01", closedAt: null, headRepository: { id: "R_repo" }, commits: { nodes: [] }, reviewThreads: { nodes: [] } };

function github(options: { fork?: boolean; pulls?: unknown[] } = {}) {
  const created: string[][] = [];
  const run: Gh = async (_scope, args) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo" && args[2] === "base/repo") return JSON.stringify({ id: "R_base", defaultBranchRef: { name: "develop" }, isFork: false, parent: null });
    if (args[0] === "repo") return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: options.fork ?? false, parent: options.fork ? { name: "repo", owner: { login: "base" } } : null });
    if (args[0] === "pr") {
      created.push(args);
      return "https://github.com/test/repo/pull/6\n";
    }
    return JSON.stringify({ data: { repository: { pullRequests: { nodes: options.pulls ?? [] } } } });
  };
  return { created, run };
}

let root: string;
let repo: string;
let environment: NodeJS.ProcessEnv;
let head: string;
beforeEach(() => {
  environment = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "flow-create-pr-"));
  repo = repository(root, "repo", ["feature"]);
  githubRemote(root, repo);
  git(repo, "switch", "--quiet", "feature");
  writeFileSync(join(repo, "work.txt"), "work");
  git(repo, "add", "work.txt");
  git(repo, "commit", "--quiet", "-m", "Add work");
  git(repo, "push", "--quiet", "origin", "feature");
  head = git(repo, "rev-parse", "HEAD").trim();
});
afterEach(() => {
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});

const input = (draft: boolean) => ({ head, title: "Add work", body: "Body text", draft });

it("creates a draft pull request against the default branch", async () => {
  const mock = github();
  assert.equal(await createPullRequest(repo, input(true), mock.run), "https://github.com/test/repo/pull/6");
  assert.deepEqual(mock.created, [["pr", "create", "--repo", "test/repo", "--head", "test:feature", "--base", "main", "--title", "Add work", "--body", "Body text", "--draft"]]);
});

it("creates a ready pull request in the parent of a fork", async () => {
  const mock = github({ fork: true });
  await createPullRequest(repo, input(false), mock.run);
  assert.deepEqual(mock.created, [["pr", "create", "--repo", "base/repo", "--head", "test:feature", "--base", "develop", "--title", "Add work", "--body", "Body text"]]);
});

it("uses the stack parent as the base of a stack branch", async () => {
  git(repo, "branch", "parent", "main");
  writeFileSync(join(repo, ".git", "gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "parent" }, { branch: "feature" }] }] }));
  const mock = github();
  await createPullRequest(repo, input(true), mock.run);
  assert.equal(mock.created[0]![mock.created[0]!.indexOf("--base") + 1], "parent");
});

it("refuses a branch that is not pushed or whose HEAD differs from the pushed commit", async () => {
  writeFileSync(join(repo, "more.txt"), "more");
  git(repo, "add", "more.txt");
  git(repo, "commit", "--quiet", "-m", "More");
  const mock = github();
  await assert.rejects(createPullRequest(repo, input(true), mock.run), /HEAD moved/);
  await assert.rejects(createPullRequest(repo, { ...input(true), head: git(repo, "rev-parse", "HEAD").trim() }, mock.run), /Push the branch/);
  git(repo, "switch", "--quiet", "-c", "local");
  await assert.rejects(createPullRequest(repo, { ...input(true), head: git(repo, "rev-parse", "HEAD").trim() }, mock.run), /Push the branch/);
  assert.deepEqual(mock.created, []);
});

it("refuses when an open pull request exists for the branch", async () => {
  const mock = github({ pulls: [open] });
  await assert.rejects(createPullRequest(repo, input(true), mock.run), /#5/);
  assert.deepEqual(mock.created, []);
});
