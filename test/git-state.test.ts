import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository, unbornRepository } from "./git-fixture.ts";
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

const pull = { id: "PR_1", number: 4, url: "https://github.com/test/repo/pull/4", title: "Change", baseRefName: "parent", state: "OPEN", isDraft: false, reviewDecision: null, updatedAt: "2025-01-01", closedAt: null, headRepository: { id: "R_repo" }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] }, reviewThreads: { nodes: [{ isResolved: false }] } };
const summary = { number: 4, url: pull.url, state: "OPEN", isDraft: false, checks: "pending", reviewDecision: null, unresolvedThreads: 1, updatedAt: "2025-01-01" };

function github() {
  const queries: string[][] = [];
  const views: string[][] = [];
  const state = { pulls: [pull] as unknown[], fail: false };
  const run: Gh = async (_scope, args) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") views.push(args);
    if (args[0] === "repo") return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: false });
    queries.push(args);
    if (state.fail) throw new Error("GitHub request failed: offline");
    return JSON.stringify({ data: { repository: { pullRequests: { nodes: state.pulls } } } });
  };
  return { queries, views, state, run };
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
    assert.deepEqual({ ...state, revision: undefined }, { revision: undefined, changed: 3, ahead: 0, behind: 0, upstream: false, branch: "main", head: git(path, "rev-parse", "HEAD").trim() });
    assert.equal(await readLocal(root), undefined);
  });

  it("reports a detached HEAD and a repository with no commits", async () => {
    const path = scope("detached");
    git(path, "switch", "--quiet", "--detach");
    assert.deepEqual({ ...await readLocal(path), revision: undefined }, { revision: undefined, changed: 0, ahead: 0, behind: 0, upstream: false, head: git(path, "rev-parse", "HEAD").trim() });
    const empty = unbornRepository(root, "empty");
    assert.deepEqual({ ...await readLocal(empty), revision: undefined }, { revision: undefined, changed: 0, ahead: 0, behind: 0, upstream: false, branch: "main" });
  });

  it("reports ahead and behind against the upstream", async () => {
    const remote = repository(root, "remote");
    const path = join(root, "clone");
    git(root, "clone", "--quiet", remote, path);
    git(path, "commit", "--quiet", "--allow-empty", "-m", "local one");
    git(path, "commit", "--quiet", "--allow-empty", "-m", "local two");
    git(remote, "commit", "--quiet", "--allow-empty", "-m", "remote");
    git(path, "fetch", "--quiet");
    assert.deepEqual({ ...await readLocal(path), revision: undefined }, { revision: undefined, changed: 0, ahead: 2, behind: 1, upstream: true, branch: "main", head: git(path, "rev-parse", "HEAD").trim() });
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

  it("keeps the base branch of an open pull request only", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    assert.equal(states.pullRequestBase(path, "main"), undefined);
    await states.poll([{ scope: path, lifecycle: "live", watched: true }]);
    assert.equal(states.pullRequestBase(path, "main"), "parent");
    assert.equal(states.pullRequestBase(path, "other"), undefined);
    fake.state.pulls = [{ ...pull, state: "MERGED" }];
    await states.poll([{ scope: path, lifecycle: "live", watched: true }], path);
    assert.equal(states.pullRequestBase(path, "main"), undefined);
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

  it("never shows the pull request of another branch", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    const poll = () => states.poll([{ scope: path, lifecycle: "live", watched: true }], path);
    await poll();
    assert.equal(states.summary(path)?.pr?.number, 4);
    git(path, "switch", "--quiet", "-c", "other");
    await states.refresh(path);
    assert.equal(states.summary(path)?.pr, undefined);
    git(path, "switch", "--quiet", "main");
    await poll();
    git(path, "checkout", "--quiet", "--detach");
    await poll();
    assert.equal(states.summary(path)?.pr, undefined);
    git(path, "switch", "--quiet", "main");
    await poll();
    git(path, "remote", "set-url", "origin", "https://gitlab.com/test/repo.git");
    await poll();
    assert.equal(states.summary(path)?.pr, undefined);
  });

  it("gives a Scope that joins a polled group the last result at the next poll", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const first = scope("first");
    const second = scope("second");
    await states.poll([{ scope: first, lifecycle: "live", watched: false }]);
    await states.poll([{ scope: first, lifecycle: "live", watched: false }, { scope: second, lifecycle: "live", watched: false }]);
    assert.equal(fake.queries.length, 1);
    assert.deepEqual(states.summary(second)?.pr, summary);
  });

  it("releases a Scope and its repository identity at the next poll without an Agent Session on it", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    assert.equal(fake.views.length, 1);
    await states.poll([]);
    assert.equal(states.summary(path), undefined);
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    assert.equal(fake.views.length, 2);
  });

  it("releases a Scope that a poll in flight at its removal put back", async () => {
    const states = new GitStates(github().run);
    const path = scope("repo");
    const inFlight = states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    await states.poll([]);
    await inFlight;
    await states.poll([]);
    assert.equal(states.summary(path), undefined);
  });

  it("releases the old Scope of a relocated Agent Session", async () => {
    const states = new GitStates(github().run);
    const from = scope("from");
    const to = scope("to");
    await states.poll([{ scope: from, lifecycle: "live", watched: false }]);
    await states.poll([{ scope: to, lifecycle: "live", watched: false }]);
    assert.equal(states.summary(from), undefined);
    assert.deepEqual(states.summary(to)?.pr, summary);
  });

  it("keeps a Scope while one Agent Session, Settled or not, is on it", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    const other = scope("other");
    await states.poll([{ scope: path, lifecycle: "live", watched: false }, { scope: path, lifecycle: "live", watched: true }]);
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    assert.deepEqual(states.summary(path)?.pr, summary);
    await states.poll([{ scope: path, lifecycle: "settled", watched: false }, { scope: other, lifecycle: "ended", watched: false }]);
    assert.deepEqual(states.summary(path)?.pr, summary);
    await states.refresh(other);
    await states.poll([{ scope: path, lifecycle: "settled", watched: false }, { scope: other, lifecycle: "ended", watched: false }]);
    assert.notEqual(states.summary(other), undefined);
    assert.equal(fake.views.length, 1);
  });

  it("releases the poll time and result of a group that has no Scope", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    await states.poll([]);
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    assert.equal(fake.queries.length, 2);
  });

  it("releases the base branch of a group that has no Scope", async () => {
    const states = new GitStates(github().run);
    const path = scope("repo");
    const bases = (states as unknown as { bases: Map<string, string | undefined> }).bases;
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    assert.equal(bases.size, 1);
    await states.poll([]);
    assert.equal(bases.size, 0);
  });

  it("queries a forced Scope at once, ignoring the interval", async () => {
    const fake = github();
    const states = new GitStates(fake.run);
    const path = scope("repo");
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    fake.state.pulls = [{ ...pull, number: 5 }];
    await states.poll([{ scope: path, lifecycle: "live", watched: false }]);
    assert.equal(states.summary(path)?.pr?.number, 4);
    await states.poll([{ scope: path, lifecycle: "live", watched: false }], path);
    assert.equal(states.summary(path)?.pr?.number, 5);
    assert.equal(fake.queries.length, 2);
  });

  it("reads git once per Scope and not at all outside a repository", async () => {
    const path = scope("repo");
    const bin = join(root, "bin");
    const log = join(root, "git.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> '${log}'\nexec /usr/bin/git "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const states = new GitStates(github().run);
    const environment = process.env.PATH;
    process.env.PATH = `${bin}:${environment}`;
    try {
      await states.poll([{ scope: root, lifecycle: "live", watched: true }, { scope: root, lifecycle: "dormant", watched: false }]);
      assert.equal(existsSync(log), false);
      await states.poll([{ scope: path, lifecycle: "live", watched: true }]);
      rmSync(log);
      await states.poll([{ scope: path, lifecycle: "live", watched: true }], path);
      const single = readFileSync(log, "utf8").split("\n").length;
      rmSync(log);
      await states.poll([{ scope: path, lifecycle: "live", watched: true }, { scope: path, lifecycle: "dormant", watched: false }], path);
      assert.equal(readFileSync(log, "utf8").split("\n").length, single);
    } finally { process.env.PATH = environment; }
  });
});
