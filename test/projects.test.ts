import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverProjects, expandHome, MAX_DEPTH } from "../src/daemon/projects.ts";

/**
 * Discovering Projects beneath a Project Root.
 *
 * Two rules carry all of this: a repository is a leaf, and nothing else is a Project. The first is
 * what prunes `node_modules` without a blacklist, and the test that proves it is the one that would
 * catch a regression presenting as "my dropdown is full of dependencies".
 */

describe("discovering Projects", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-projects-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A repository at `<root>/<relative>`, marked the way git marks a normal checkout. */
  const repo = (relative: string): string => {
    const path = join(root, relative);
    mkdirSync(join(path, ".git"), { recursive: true });
    return path;
  };

  const paths = (): string[] => discoverProjects(root).map((project) => project.path);

  it("offers a direct child with no group, and a nested one grouped by the folders above it", () => {
    repo("repo-a");
    repo("work/repo-b");
    repo("work/backend/repo-c");

    // Ungrouped first, then a group before the groups nested inside it — which is the order the
    // headings have to appear in, since a flat list means every item sharing a group is contiguous.
    assert.deepEqual(discoverProjects(root), [
      { path: join(root, "repo-a"), name: "repo-a" },
      { path: join(root, "work/repo-b"), name: "repo-b", group: "work" },
      { path: join(root, "work/backend/repo-c"), name: "repo-c", group: "work/backend" },
    ]);
  });

  /**
   * The rule the whole design rests on. A repository is recorded and never looked inside, which is
   * why no blacklist of build directories is needed — and why a monorepo offers only itself.
   */
  it("never looks inside a repository, so dependencies and subpackages are not Projects", () => {
    repo("monorepo");
    repo("monorepo/node_modules/some-package");
    repo("monorepo/packages/api");
    mkdirSync(join(root, "monorepo/packages/web"), { recursive: true });

    assert.deepEqual(paths(), [join(root, "monorepo")]);
  });

  it("counts a .git file, not just a directory, so a linked worktree is a Project", () => {
    // What git writes in a linked worktree or a submodule: a file holding a `gitdir:` pointer.
    mkdirSync(join(root, "feature"), { recursive: true });
    writeFileSync(join(root, "feature/.git"), "gitdir: /elsewhere/.git/worktrees/feature\n");

    assert.deepEqual(paths(), [join(root, "feature")]);
  });

  it("treats a Project Root that is itself a repository as the one Project it offers", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    repo("packages/api");

    // Not empty, which is what the naive walk would report: every repository beneath this root is
    // inside it, so none of them is ever visited.
    assert.deepEqual(discoverProjects(root), [
      { path: root, name: root.split("/").filter(Boolean).at(-1) },
    ]);
  });

  it("ignores a directory that is not a repository, and one that is hidden", () => {
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, "empty/nested"), { recursive: true });
    repo(".hidden/repo-x");

    assert.deepEqual(paths(), []);
  });

  it(`stops at ${MAX_DEPTH} levels below the root`, () => {
    repo("a/b/c/too-deep");
    repo("a/b/at-the-limit");

    assert.deepEqual(paths(), [join(root, "a/b/at-the-limit")]);
  });

  /** A symlink is not followed, which is the only way this walk could fail to terminate. */
  it("does not follow a symlink, so a loop cannot hang it", () => {
    repo("real");
    symlinkSync(root, join(root, "loop"), "dir");

    assert.deepEqual(paths(), [join(root, "real")]);
  });

  it("says nothing rather than throwing when there is no root, or it does not exist", () => {
    assert.deepEqual(discoverProjects(undefined), []);
    assert.deepEqual(discoverProjects(join(root, "not-there")), []);
    // Relative would resolve against the daemon's working directory, which its reader cannot see.
    assert.deepEqual(discoverProjects("./relative"), []);
  });

  it("expands a leading tilde, because that is what a person types into a config file", () => {
    assert.equal(expandHome("~"), process.env["HOME"]);
    assert.equal(expandHome("~/workspace"), join(process.env["HOME"] ?? "", "workspace"));
    // Only a leading `~/` — a directory genuinely called `~backup` is left alone.
    assert.equal(expandHome("/srv/~backup"), "/srv/~backup");
  });
});
