import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { changes, diff } from "../src/daemon/changes.ts";
import type { Gh } from "../src/daemon/github.ts";

const calls: string[][] = [];
const github: Gh = async (_scope, args) => {
  calls.push(args);
  if (args[0] === "auth") return "";
  return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: false, parent: null });
};

let root: string;
let repo: string;
beforeEach(() => {
  calls.length = 0;
  root = mkdtempSync(join(tmpdir(), "flow-changes-"));
  repo = repository(root, "repo");
  git(repo, "remote", "add", "origin", "git@github.com:test/repo.git");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function commit(path: string, content: string | Buffer, message: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", message);
}

it("lists staged, unstaged and untracked files in the uncommitted view", async () => {
  commit("staged.txt", "one\n", "add staged");
  writeFileSync(join(repo, "staged.txt"), "two\n");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "README.md"), "# changed\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  const listed = await changes(repo, "uncommitted");
  assert.deepEqual(listed, { files: [{ status: " M", path: "README.md" }, { status: "M ", path: "staged.txt" }, { status: "??", path: "new.txt" }], commits: [] });
  const staged = await diff(repo, "uncommitted", "staged.txt");
  assert.ok("text" in staged && staged.text.includes("-one\n+two\n"));
});

it("renders an untracked file as an all-added diff", async () => {
  writeFileSync(join(repo, "new.txt"), "first\nsecond");
  assert.deepEqual(await diff(repo, "uncommitted", "new.txt"), {
    text: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file\n",
  });
  symlinkSync("README.md", join(repo, "link"));
  assert.deepEqual(await diff(repo, "uncommitted", "link"), { text: "--- /dev/null\n+++ b/link\n@@ -0,0 +1,1 @@\n+README.md\n\\ No newline at end of file\n" });
});

it("reports binary tracked and untracked files", async () => {
  commit("image.bin", Buffer.from([0, 1, 2, 3]), "add binary");
  writeFileSync(join(repo, "image.bin"), Buffer.from([0, 4, 5, 6]));
  writeFileSync(join(repo, "new.bin"), Buffer.from([7, 0, 8]));
  assert.deepEqual(await diff(repo, "uncommitted", "image.bin"), { binary: true });
  assert.deepEqual(await diff(repo, "uncommitted", "new.bin"), { binary: true });
});

it("refuses to show a diff above the size cap", async () => {
  commit("large.txt", "small\n", "add large");
  writeFileSync(join(repo, "large.txt"), `${"y".repeat(99)}\n`.repeat(5_000));
  assert.deepEqual(await diff(repo, "uncommitted", "large.txt"), { tooLarge: true });
  writeFileSync(join(repo, "large.txt"), `${"z".repeat(99)}\n`.repeat(20_000));
  assert.deepEqual(await diff(repo, "uncommitted", "large.txt"), { tooLarge: true });
  writeFileSync(join(repo, "untracked.txt"), "u".repeat(500_000));
  assert.deepEqual(await diff(repo, "uncommitted", "untracked.txt"), { tooLarge: true });
});

it("refuses a path that is not in the list of changes", async () => {
  writeFileSync(join(repo, "new.txt"), "new\n");
  await assert.rejects(diff(repo, "uncommitted", "README.md"), /not in the list of changes/);
  await assert.rejects(diff(repo, "uncommitted", "../outside.txt"), /not in the list of changes/);
});

it("shows paths with spaces and non-ASCII characters, and deleted files", async () => {
  commit("dir with space/ä.txt", "old\n", "add spaced");
  writeFileSync(join(repo, "dir with space/ä.txt"), "new\n");
  writeFileSync(join(repo, "my file ü.txt"), "added\n");
  unlinkSync(join(repo, "README.md"));
  const listed = await changes(repo, "uncommitted");
  assert.deepEqual(listed.files.map(file => file.path).sort(), ["README.md", "dir with space/ä.txt", "my file ü.txt"]);
  const spaced = await diff(repo, "uncommitted", "dir with space/ä.txt");
  assert.ok("text" in spaced && spaced.text.includes("-old\n+new\n"));
  assert.deepEqual(await diff(repo, "uncommitted", "my file ü.txt"), { text: "--- /dev/null\n+++ b/my file ü.txt\n@@ -0,0 +1,1 @@\n+added\n" });
  const deleted = await diff(repo, "uncommitted", "README.md");
  assert.ok("text" in deleted && deleted.text.includes("deleted file") && deleted.text.includes("-# test\n"));
});

it("lists the branch changes and commits from the merge-base with the Base Branch", async () => {
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "switch", "--quiet", "-c", "feature");
  commit("feature.txt", "feature\n", "Add feature");
  git(repo, "switch", "--quiet", "main");
  commit("main.txt", "main\n", "Change main");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "switch", "--quiet", "feature");
  writeFileSync(join(repo, "uncommitted.txt"), "not listed\n");
  const listed = await changes(repo, "branch", undefined, github);
  const hash = git(repo, "rev-parse", "--short", "HEAD").trim();
  assert.deepEqual(listed, { files: [{ status: "A", path: "feature.txt" }], commits: [`${hash} Add feature`], base: "origin/main" });
  const added = await diff(repo, "branch", "feature.txt", undefined, github);
  assert.ok("text" in added && added.text.includes("+feature\n"));
  await assert.rejects(diff(repo, "branch", "main.txt", undefined, github), /not in the list of changes/);
  await changes(repo, "branch", undefined, github);
  assert.equal(calls.filter(args => args[0] === "repo").length, 1);
});

it("uses the pull request base when Git State knows it", async () => {
  git(repo, "update-ref", "refs/remotes/origin/parent", "HEAD");
  git(repo, "switch", "--quiet", "-c", "child");
  commit("child.txt", "child\n", "Add child");
  assert.equal((await changes(repo, "branch", "parent", github)).base, "origin/parent");
});

it("asks for a fetch when the base ref is not known locally", async () => {
  git(repo, "branch", "-m", "main", "feature");
  await assert.rejects(changes(repo, "branch", undefined, github), /Fetch main from origin/);
});
