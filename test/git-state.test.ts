import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { GitStates, readLocal } from "../src/daemon/git-state.ts";
import type { Gh } from "../src/daemon/github.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "flow-git-state-")); });
afterEach(() => { mock.timers.reset(); rmSync(root, { recursive: true, force: true }); });

function scope(name: string): string {
  const path = repository(root, name);
  git(path, "remote", "add", "origin", "git@github.com:test/repo.git");
  return path;
}

const pull = { id: "PR_1", number: 4, url: "https://github.com/test/repo/pull/4", title: "Change", state: "OPEN", isDraft: false, reviewDecision: null, updatedAt: "2025-01-01", closedAt: null, headRepository: { id: "R_repo" }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] }, reviewThreads: { nodes: [{ isResolved: false }] } };
const summary = { number: 4, url: pull.url, state: "OPEN", isDraft: false, checks: "pending", reviewDecision: null, unresolvedThreads: 1 };

function github() {
  const queries: string[][] = [];
  const state = { pulls: [pull] as unknown[], fail: false };
  const run: Gh = async (_scope, args) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: false });
    queries.push(args);
    if (state.fail) throw new Error("GitHub request failed: offline");
    return JSON.stringify({ data: { repository: { pullRequests: { nodes: state.pulls } } } });
  };
  return { queries, state, run };
}

describe("readLocal", () => {
  it("counts changed files and reports no upstream", async () => {
    const path = scope("repo");
    writeFileSync(join(path, "README.md"), "changed\n");
    writeFileSync(join(path, "staged.txt"), "staged");
    git(path, "add", "staged.txt");
    writeFileSync(join(path, "a file.txt"), "untracked");
    git(path, "mv", "README.md", "moved.md");
    const state = await readLocal(path);
    assert.deepEqual({ ...state, revision: undefined }, { revision: undefined, changed: 3, ahead: 0, behind: 0, upstream: false });
    assert.equal(await readLocal(root), undefined);
  });

  it("reports ahead and behind against the upstream", async () => {
    const remote = repository(root, "remote");
    const path = join(root, "clone");
    git(root, "clone", "--quiet", remote, path);
    git(path, "commit", "--quiet", "--allow-empty", "-m", "local one");
    git(path, "commit", "--quiet", "--allow-empty", "-m", "local two");
    git(remote, "commit", "--quiet", "--allow-empty", "-m", "remote");
    git(path, "fetch", "--quiet");
    assert.deepEqual({ ...await readLocal(path), revision: undefined }, { revision: undefined, changed: 0, ahead: 2, behind: 1, upstream: true });
  });

  it("changes revision when a changed file changes again", async () => {
    const path = scope("repo");
    writeFileSync(join(path, "README.md"), "one\n");
    const first = (await readLocal(path))!.revision;
    assert.equal((await readLocal(path))!.revision, first);
    writeFileSync(join(path, "README.md"), "one two\n");
    assert.notEqual((await readLocal(path))!.revision, first);
    renameSync(join(path, "README.md"), join(path, "other.md"));
    assert.notEqual((await readLocal(path))!.revision, first);
  });
});

describe("GitStates", () => {
  it("reads at most once each 3 s with one trailing read", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
    const reads: string[] = [];
    const states = new GitStates(github().run, async (path) => { reads.push(path); return { revision: String(reads.length), changed: 0, ahead: 0, behind: 0, upstream: false }; });
    states.touch("scope");
    states.touch("scope");
    states.touch("scope");
    assert.equal(reads.length, 1);
    mock.timers.tick(2_999);
    assert.equal(reads.length, 1);
    mock.timers.tick(1);
    assert.equal(reads.length, 2);
    mock.timers.tick(10_000);
    assert.equal(reads.length, 2);
    states.touch("scope");
    assert.equal(reads.length, 3);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(states.summary("scope")?.revision, "3");
  });

  it("polls one query per repository and branch and shares the result", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const first = scope("first");
    const second = scope("second");
    await states.poll([{ scope: first, lifecycle: "live", watched: false }, { scope: second, lifecycle: "dormant", watched: false }, { scope: second, lifecycle: "live", watched: true }]);
    assert.equal(fake.queries.length, 1);
    assert.deepEqual(states.summary(first)?.pr, summary);
    assert.deepEqual(states.summary(second)?.pr, summary);
  });

  it("polls each 30 s when watched and each 5 min otherwise", async () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const watched = github();
    const unwatched = github();
    const watchedStates = new GitStates(watched.run);
    const unwatchedStates = new GitStates(unwatched.run);
    const path = scope("repo");
    const poll = async () => {
      await watchedStates.poll([{ scope: path, lifecycle: "live", watched: true }]);
      await unwatchedStates.poll([{ scope: path, lifecycle: "live", watched: false }]);
    };
    await poll();
    mock.timers.tick(29_999);
    await poll();
    assert.deepEqual([watched.queries.length, unwatched.queries.length], [1, 1]);
    mock.timers.tick(1);
    await poll();
    assert.deepEqual([watched.queries.length, unwatched.queries.length], [2, 1]);
    mock.timers.tick(270_000);
    await poll();
    assert.deepEqual([watched.queries.length, unwatched.queries.length], [3, 2]);
  });

  it("does not poll Settled or Ended sessions and keeps their last value", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    await states.refresh(path);
    await states.poll([{ scope: path, lifecycle: "live", watched: true }]);
    fake.state.pulls = [];
    await states.poll([{ scope: path, lifecycle: "settled", watched: true }, { scope: path, lifecycle: "ended", watched: true }]);
    assert.equal(fake.queries.length, 1);
    assert.deepEqual(states.summary(path)?.pr, summary);
  });

  it("keeps the last value when a poll fails and clears it when the pull request is gone", async () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    await states.refresh(path);
    await states.poll([{ scope: path, lifecycle: "live", watched: true }]);
    fake.state.fail = true;
    mock.timers.tick(30_000);
    await states.poll([{ scope: path, lifecycle: "live", watched: true }]);
    assert.deepEqual(states.summary(path)?.pr, summary);
    fake.state.fail = false;
    fake.state.pulls = [];
    mock.timers.tick(30_000);
    await states.poll([{ scope: path, lifecycle: "live", watched: true }]);
    assert.equal(states.summary(path)?.pr, undefined);
    assert.equal(fake.queries.length, 3);
  });
});
