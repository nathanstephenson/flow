import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { git, repository, unbornRepository } from "./git-fixture.ts";
import {
  createWorktree,
  derivedBranchName,
  flattenBranch,
  gitAvailable,
  head,
  isClean,
  isRepository,
  localBranches,
  planWorktree,
  removeWorktree,
  switchBranch,
} from "../src/daemon/git.ts";

/**
 * `src/daemon/git.ts` against real repositories.
 *
 * Real git, not a fake, for the reason `shell.test.ts` uses a real pty: what is being defended here
 * is agreement with git's own behaviour — which argument it reads as a flag, when it refuses a
 * checkout, what a linked worktree's `.git` is — and a fake would let every one of these pass while
 * the feature was broken.
 */

let root: string;

const newRepo = (name: string, branches: string[] = []) => repository(root, name, branches);

before(() => {
  root = mkdtempSync(join(tmpdir(), "flow-git-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git availability", () => {
  it("finds the git this test suite is already using", async () => {
    assert.equal(await gitAvailable(), true);
  });
});

describe("isRepository", () => {
  it("is false for a directory that merely exists", () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    assert.equal(isRepository(plain), false);
  });

  it("is true for an ordinary checkout", () => {
    assert.equal(isRepository(newRepo("ordinary")), true);
  });

  // The case every worktree this module creates is, and the reason `.git` is tested as a path that
  // exists rather than as a directory.
  it("is true for a linked worktree, whose .git is a file", async () => {
    const repo = newRepo("linked");
    const created = await createWorktree({ repo, from: "main", under: join(root, "trees") });
    assert.equal(created.ok, true);
    assert.equal(isRepository(created.ok ? created.value.path : ""), true);
  });
});

describe("head", () => {
  it("names the branch a checkout is on", async () => {
    const result = await head(newRepo("on-main"));
    assert.deepEqual(result, { ok: true, value: { name: "main" } });
  });

  // `rev-parse --abbrev-ref HEAD` calls this an ambiguous argument. Reporting a freshly created
  // repository as broken rather than as empty is the bug this defends against.
  it("names the unborn branch of a repository with no commits", async () => {
    const result = await head(unbornRepository(root, "unborn"));
    assert.deepEqual(result, { ok: true, value: { name: "main" } });
  });

  it("names the commit, not a branch called HEAD, when HEAD is detached", async () => {
    const repo = newRepo("detached");
    const sha = git(repo, "rev-parse", "--short", "HEAD").trim();
    git(repo, "checkout", "--quiet", "--detach", sha);

    const result = await head(repo);
    assert.deepEqual(result, { ok: true, value: { name: sha, detached: true } });
  });

  it("fails rather than throws outside a repository", async () => {
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const result = await head(plain);
    assert.equal(result.ok, false);
  });
});

describe("localBranches", () => {
  it("lists local branches, most recently committed first", async () => {
    const result = await localBranches(newRepo("many", ["older", "newer"]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // All three share the one commit's committerdate, so membership is the assertion, not order.
    assert.deepEqual([...result.value].sort(), ["main", "newer", "older"]);
  });

  it("is empty in a repository with no commits", async () => {
    const result = await localBranches(unbornRepository(root, "unborn-branches"));
    assert.deepEqual(result, { ok: true, value: [] });
  });
});

describe("isClean", () => {
  it("is true with nothing uncommitted, and false once something is untracked", async () => {
    const repo = newRepo("cleanliness");
    assert.deepEqual(await isClean(repo), { ok: true, value: true });

    writeFileSync(join(repo, "scratch.txt"), "uncommitted\n");
    assert.deepEqual(await isClean(repo), { ok: true, value: false });
  });
});

describe("switchBranch", () => {
  it("moves the working tree and reports where it landed", async () => {
    const repo = newRepo("switching", ["feature"]);
    const result = await switchBranch(repo, "feature");
    assert.deepEqual(result, { ok: true, value: { name: "feature" } });
    assert.deepEqual(await head(repo), { ok: true, value: { name: "feature" } });
  });

  // git's own judgement, surfaced rather than reimplemented: it refuses a checkout that would
  // clobber a modified file, and its message says so better than we could.
  it("surfaces git's refusal when a change would be clobbered", async () => {
    const repo = newRepo("clobber", ["other"]);
    git(repo, "switch", "--quiet", "other");
    writeFileSync(join(repo, "README.md"), "# other\n");
    git(repo, "commit", "--quiet", "-am", "diverge");
    git(repo, "switch", "--quiet", "main");
    writeFileSync(join(repo, "README.md"), "# local edit\n");

    const result = await switchBranch(repo, "other");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.failure.message, /would be overwritten|local changes/i);
    assert.deepEqual(await head(repo), { ok: true, value: { name: "main" } });
  });

  // `git switch` has no `--` to hide a name behind, so a name git would read as a flag is refused
  // before it is passed on.
  it("refuses an option-like name without invoking git", async () => {
    const repo = newRepo("option-like");
    const result = await switchBranch(repo, "--force");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.failure.message, /not a branch name/);
    assert.equal(result.failure.code, undefined);
    assert.deepEqual(await head(repo), { ok: true, value: { name: "main" } });
  });
});

describe("flattenBranch", () => {
  it("makes one path segment out of a slashed branch", () => {
    assert.equal(flattenBranch("feature/login"), "feature-login");
  });

  it("drops the namespace, which the directory's position already says", () => {
    assert.equal(flattenBranch("flow/main-36000000"), "main-36000000");
  });

  // Lossy on purpose: nothing reads a branch back out of a path, so collisions are settled by
  // probing for a free directory rather than by an escaping scheme nobody can read.
  it("collapses two distinct branches onto one segment", () => {
    assert.equal(flattenBranch("feature/login"), flattenBranch("feature-login"));
  });

  it("falls back rather than returning an empty segment", () => {
    assert.equal(flattenBranch("///"), "branch");
  });
});

describe("derivedBranchName", () => {
  it("names the base branch's leaf and the millisecond of the UTC day, in exactly two segments", () => {
    // 10:00:00Z is ten hours in: 10 * 3_600_000.
    const name = derivedBranchName({ from: "main", now: new Date("2026-09-04T10:00:00Z") });
    assert.equal(name, "flow/main-36000000");
    assert.equal(name.split("/").length, 2);
  });

  // Git refs are files: a third segment would make `flow/release/2.1` unable to coexist
  // with `flow/release`, which is a trap that fires on the second worktree of the day.
  it("stays two segments even when the base branch is itself slashed", () => {
    const name = derivedBranchName({ from: "release/2.1", now: new Date("2026-09-04T10:00:00Z") });
    assert.equal(name, "flow/2.1-36000000");
    assert.equal(name.split("/").length, 2);
  });

  it("counts from UTC midnight, not from the epoch", () => {
    assert.equal(derivedBranchName({ from: "main", now: new Date("2026-09-04T00:00:00Z") }), "flow/main-0");
    // One millisecond before the next midnight is the largest value it can take.
    assert.equal(
      derivedBranchName({ from: "main", now: new Date("2026-09-04T23:59:59.999Z") }),
      "flow/main-86399999",
    );
  });

  /*
   * The whole reason for the change. Two worktrees cut from `main` minutes apart used to want the
   * same name, so the second wore a `-2` that said nothing; now they differ on their own.
   */
  it("differs for two worktrees cut in the same day", () => {
    const morning = derivedBranchName({ from: "main", now: new Date("2026-09-04T09:00:00Z") });
    const afternoon = derivedBranchName({ from: "main", now: new Date("2026-09-04T15:30:00Z") });
    assert.notEqual(morning, afternoon);
  });
});

describe("planWorktree", () => {
  /*
   * The counter is effectively retired for derived names now that they carry a millisecond, but the
   * probe is still what makes that safe rather than assumed — so it is pinned by handing it a name
   * that is already taken.
   */
  it("bumps a derived name that is already taken, inside the last segment", async () => {
    const now = new Date("2026-09-04T10:00:00Z");
    const repo = newRepo("planning", ["flow/main-36000000"]);
    const planned = await planWorktree({ repo, from: "main", under: join(root, "plans"), now });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.equal(planned.value.branch, "flow/main-36000000-2");
  });

  // Someone who typed a name and got a different one has been ignored, so a supplied name is
  // refused rather than bumped. Bumping exists only for the derived name.
  it("refuses a supplied name that exists rather than bumping it", async () => {
    const repo = newRepo("supplied", ["taken"]);
    const planned = await planWorktree({
      repo,
      from: "main",
      branch: "taken",
      under: join(root, "plans-supplied"),
    });
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.match(planned.failure.message, /already exists/);
  });

  it("puts the worktree under the repository's own name", async () => {
    const repo = newRepo("naming");
    const under = join(root, "plans-naming");
    const planned = await planWorktree({
      repo,
      from: "main",
      under,
      now: new Date("2026-09-04T10:00:00Z"),
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.equal(planned.value.path, join(under, "naming", "main-36000000"));
  });
});

describe("createWorktree", () => {
  it("cuts from a branch that is checked out elsewhere, and leaves it alone", async () => {
    const repo = newRepo("cutting");
    const under = join(root, "cut");
    // The repository itself is on `main`, which is exactly the case `-b` makes a non-problem.
    const created = await createWorktree({ repo, from: "main", under });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.equal(existsSync(join(created.value.path, "README.md")), true);
    assert.deepEqual(await head(created.value.path), {
      ok: true,
      value: { name: created.value.branch },
    });
    assert.deepEqual(await head(repo), { ok: true, value: { name: "main" } });
  });

  it("fails, and creates nothing, when the base branch does not exist", async () => {
    const repo = newRepo("absent-base");
    const under = join(root, "absent");
    const created = await createWorktree({ repo, from: "no-such-branch", under });
    assert.equal(created.ok, false);
    assert.equal(existsSync(join(under, "absent-base")), false);
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree but leaves its branch behind", async () => {
    const repo = newRepo("removal");
    const created = await createWorktree({ repo, from: "main", under: join(root, "removals") });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const removed = await removeWorktree({ repo, path: created.value.path });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(created.value.path), false);

    // The whole reason a reap can be safe: the work is still reachable by name.
    const branches = await localBranches(repo);
    assert.equal(branches.ok && branches.value.includes(created.value.branch), true);
  });

  // No `--force`, so this refuses. The caller establishes cleanliness first; without the refusal
  // that check would be decorative.
  it("refuses a worktree with uncommitted work in it", async () => {
    const repo = newRepo("dirty-removal");
    const created = await createWorktree({ repo, from: "main", under: join(root, "dirty") });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    writeFileSync(join(created.value.path, "scratch.txt"), "uncommitted\n");
    const removed = await removeWorktree({ repo, path: created.value.path });
    assert.equal(removed.ok, false);
    assert.equal(existsSync(created.value.path), true);
  });
});
