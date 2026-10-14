import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { localBranches } from "../src/daemon/git.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { git, repository } from "./git-fixture.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Worktrees: created at birth, owned by the Session Host, and reaped only while clean.
 *
 * A worktree is a Scope, so it is chosen when an Agent Session is created and never afterwards —
 * `create` is the only entry point here on purpose, because an Agent Session is bound to its Scope
 * for its whole life.
 */
describe("worktrees", () => {
  let root: string;
  let work: string;
  let store: TranscriptStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-state-"));
    work = mkdtempSync(join(tmpdir(), "flow-work-"));
    store = new TranscriptStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  async function hostWith(retention: number | "never" = DAY): Promise<SessionHost> {
    const host = new SessionHost({ store, retention });
    host.registerBackend(new FakeBackend());
    await host.load();
    return host;
  }

  it("binds the Agent Session to the worktree, not to the repository it was cut from", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");

    const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });

    const summary = host.list().find((entry) => entry.id === id);
    assert.ok(summary);
    assert.notEqual(summary.scope, repo);
    assert.equal(summary.scope.startsWith(join(store.worktreesRoot(), "api")), true);
    assert.equal(summary.worktree, true);
    assert.equal(existsSync(join(summary.scope, "README.md")), true);
  });

  it("cuts a new branch and leaves the repository where it was", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");

    const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });

    const summary = host.list().find((entry) => entry.id === id);
    assert.ok(summary?.branch);
    // `flow/<base leaf>-<ms into the UTC day>`, in exactly two segments — see `derivedBranchName`.
    assert.match(summary.branch.name, /^flow\/main-\d+$/);
    // The base branch is cut from, never checked out: the repository is still on main.
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "main");
  });

  it("records the worktree in meta, and reads it back after a restart", async () => {
    const first = await hostWith();
    const repo = repository(work, "api");
    const id = await first.create({ scope: repo, backend: "fake", worktree: { from: "main" } });

    const meta = store.readMeta(id);
    assert.ok(meta?.worktree);
    assert.equal(meta.worktree.repo, repo);
    assert.equal(meta.worktree.path, meta.scope);
    assert.match(meta.worktree.branch, /^flow\/main-/);

    // The flag has to survive a bounce, or the daemon that reaps this session is not the one that
    // knows it owns a directory.
    const second = await hostWith();
    assert.equal(second.list().find((entry) => entry.id === id)?.worktree, true);
  });

  it("takes the next name when one was already cut today", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");

    const first = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
    const second = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });

    const names = [first, second].map(
      (id) => host.list().find((entry) => entry.id === id)?.branch?.name,
    );
    assert.equal(new Set(names).size, 2, "two Agent Sessions must not share one branch");
    const branches = await localBranches(repo);
    assert.equal(branches.ok, true);
    if (!branches.ok) return;
    for (const name of names) assert.equal(branches.value.includes(name ?? ""), true);
  });

  it("refuses a supplied branch name that already exists, rather than quietly picking another", async () => {
    const host = await hostWith();
    const repo = repository(work, "api", ["taken"]);

    await assert.rejects(
      () => host.create({ scope: repo, backend: "fake", worktree: { from: "main", branch: "taken" } }),
      /already exists/,
    );
  });

  it("refuses a Scope that is not a repository", async () => {
    const host = await hostWith();
    const plain = join(work, "notes");
    mkdirSync(plain, { recursive: true });

    await assert.rejects(
      () => host.create({ scope: plain, backend: "fake", worktree: { from: "main" } }),
      /not a git repository/,
    );
  });

  // The reason the worktree is created before the record: a failure must leave nothing behind, not
  // an Agent Session bound to a directory that was never made.
  it("creates no Agent Session when the base branch does not exist", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");

    await assert.rejects(() =>
      host.create({ scope: repo, backend: "fake", worktree: { from: "no-such-branch" } }),
    );
    assert.deepEqual(host.list(), []);
    assert.equal(existsSync(join(store.worktreesRoot(), "api")), false);
  });

  describe("reaping", () => {
    it("removes a clean worktree and its merged local branch", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      assert.equal(existsSync(scope), false, "the worktree is gone");
      assert.equal(existsSync(store.sessionDir(id)), false, "and so is the transcript");
      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(branch), false);
    });

    it("preserves a branch with unmerged commits while removing its worktree", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "commit", "--allow-empty", "-m", "unmerged");
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      assert.equal(existsSync(scope), false);
      assert.equal(git(repo, "log", "-1", "--format=%s", branch).trim(), "unmerged");
    });

    it("preserves unmerged commits when the source repository has a detached HEAD", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "commit", "--allow-empty", "-m", "unmerged");
      git(repo, "checkout", "--detach", branch);
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      assert.equal(existsSync(scope), false);
      assert.equal(git(repo, "log", "-1", "--format=%s", branch).trim(), "unmerged");
    });

    it("removes a branch after its commits are merged", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "commit", "--allow-empty", "-m", "finished");
      git(repo, "merge", "--ff-only", branch);
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(branch), false);
      assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "finished");
    });

    it("removes the merged branch currently checked out and the original branch", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const original = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "switch", "-c", "fix/finished");
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(original), false);
      assert.equal(branches.ok && branches.value.includes("fix/finished"), false);
    });

    it("removes a renamed merged branch after a host restart", async () => {
      const first = await hostWith();
      const repo = repository(work, "api");
      const id = await first.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = first.list().find((entry) => entry.id === id)?.scope ?? "";
      git(scope, "branch", "-m", "fix/renamed");
      await first.settle(id);
      const second = await hostWith();

      assert.deepEqual(await second.reap(Date.now() + DAY + 1000), [id]);

      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes("fix/renamed"), false);
    });

    it("preserves a pushed branch whose commits are not merged locally", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "commit", "--allow-empty", "-m", "pushed but unmerged");
      const remote = join(work, "remote.git");
      git(repo, "init", "--bare", "--initial-branch=main", remote);
      git(repo, "remote", "add", "origin", remote);
      git(scope, "push", "--set-upstream", "origin", branch);
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      assert.equal(git(repo, "log", "-1", "--format=%s", branch).trim(), "pushed but unmerged");
      assert.equal(git(remote, "log", "-1", "--format=%s", branch).trim(), "pushed but unmerged");
    });

    it("removes a merged local branch without removing its remote branch", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "commit", "--allow-empty", "-m", "finished");
      const remote = join(work, "remote.git");
      git(repo, "init", "--bare", "--initial-branch=main", remote);
      git(repo, "remote", "add", "origin", remote);
      git(scope, "push", "--set-upstream", "origin", branch);
      git(repo, "merge", "--ff-only", branch);
      const remoteCommit = git(remote, "rev-parse", `refs/heads/${branch}`).trim();
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(branch), false);
      assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`).trim(), remoteCommit);
    });

    it("preserves branches checked out in another worktree", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(scope, "switch", "main", "--ignore-other-worktrees");
      const other = join(work, "other");
      git(repo, "worktree", "add", other, branch);
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(branch), true);
      assert.equal(branches.ok && branches.value.includes("main"), true);
      assert.equal(existsSync(other), true);
    });

    it("does not remove branches when worktree removal fails", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      git(repo, "worktree", "lock", scope);
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      assert.equal(existsSync(scope), true);
      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(branch), true);
    });

    it("leaves a dirty worktree alone, and says why", async () => {
      const host = await hostWith();
      const repo = repository(work, "api");
      const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
      const scope = host.list().find((entry) => entry.id === id)?.scope ?? "";
      const branch = host.list().find((entry) => entry.id === id)?.branch?.name ?? "";
      writeFileSync(join(scope, "unfinished.txt"), "work in progress\n");
      await host.settle(id);

      const kept: Array<{ path: string; reason: string }> = [];
      host.onWorktreeKept((event) => kept.push({ path: event.path, reason: event.reason }));

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);

      // The Agent Session goes, because that is what the retention window is about. The uncommitted
      // work stays, because deleting it on a timer is the one thing ADR 0006 does not license.
      assert.equal(existsSync(store.sessionDir(id)), false);
      assert.equal(existsSync(join(scope, "unfinished.txt")), true);
      const branches = await localBranches(repo);
      assert.equal(branches.ok && branches.value.includes(branch), true);
      assert.equal(kept.length, 1);
      assert.equal(kept[0]?.path, scope);
      assert.match(kept[0]?.reason ?? "", /uncommitted/);
    });

    // The test that earns `SessionMeta.worktree` being recorded rather than derived from the path:
    // a Scope that merely sits beneath the worktrees root is not ours to remove.
    it("does not touch a Scope that only looks like a worktree", async () => {
      const host = await hostWith();
      const impostor = join(store.worktreesRoot(), "api", "hand-made");
      mkdirSync(impostor, { recursive: true });
      writeFileSync(join(impostor, "mine.txt"), "not the host's to delete\n");

      const id = await host.create({ scope: impostor, backend: "fake" });
      await host.settle(id);

      assert.deepEqual(await host.reap(Date.now() + DAY + 1000), [id]);
      assert.equal(existsSync(join(impostor, "mine.txt")), true);
    });
  });
});
