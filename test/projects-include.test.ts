import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { includedProjects, searchDirectories, MAX_SEARCH_DEPTH } from "../src/daemon/projects.ts";

/**
 * The opted-in Projects, and the two searches that help you opt in.
 *
 * `projects.include` *is* the Projects list. Discovery only suggests candidates for it, which is the
 * distinction these tests exist to hold: an entry names a directory, and nothing checks whether it
 * is a repository, because someone chose it deliberately.
 */

describe("the opted-in Projects", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goodharness-include-"));
    for (const path of ["work/api/.git", "work/backend/db/.git", "notes", "solo/.git"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a relative entry against the Project Root and derives its heading", () => {
    assert.deepEqual(includedProjects(root, ["work/api", "solo"]), [
      { path: join(root, "work/api"), name: "api", group: "work" },
      { path: join(root, "solo"), name: "solo" },
    ]);
  });

  it("keeps the configured order rather than sorting it", () => {
    // Curated by hand, so the order is a decision someone made. Discovery sorts; this must not.
    const paths = includedProjects(root, ["solo", "work/backend/db", "work/api"]).map((p) => p.name);
    assert.deepEqual(paths, ["solo", "db", "api"]);
  });

  it("takes a directory that is not a repository, because it was chosen deliberately", () => {
    // The whole point of opting in: `notes` holds no `.git` and discovery would never offer it.
    assert.deepEqual(includedProjects(root, ["notes"]), [
      { path: join(root, "notes"), name: "notes" },
    ]);
  });

  it("reports a Project whose directory has gone rather than dropping it", () => {
    // Silently omitting it would look exactly like the Setting having failed to save.
    assert.deepEqual(includedProjects(root, ["work/api", "deleted-repo"]), [
      { path: join(root, "work/api"), name: "api", group: "work" },
      { path: join(root, "deleted-repo"), name: "deleted-repo", missing: true },
    ]);
  });

  it("takes an absolute entry outside the root, and gives it no heading", () => {
    assert.deepEqual(includedProjects(root, ["/tmp"]), [{ path: "/tmp", name: "tmp" }]);
  });

  it("collapses two spellings of one directory into one row", () => {
    const projects = includedProjects(root, ["work/api", "work/api/", join(root, "work/api")]);
    assert.equal(projects.length, 1, "a duplicate is a no-op, not a second row");
  });

  it("drops a relative entry when there is no root for it to be relative to", () => {
    assert.deepEqual(includedProjects(undefined, ["work/api"]), []);
    // An absolute one still works, which is why a bad root does not cost the whole list.
    assert.deepEqual(includedProjects(undefined, ["/tmp"]), [{ path: "/tmp", name: "tmp" }]);
  });
});

describe("searching for a directory to opt in", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goodharness-dirsearch-"));
    for (const path of [
      "work/api/.git",
      "work/api/packages/api-server",
      "work/api/node_modules/left-pad",
      "work/web/dist/assets",
      "notes/2024",
      ".hidden/secret",
    ]) {
      mkdirSync(join(root, path), { recursive: true });
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const search = (q: string): string[] => searchDirectories(root, q).paths;

  it("fuzzy-matches a name beneath the root, shallowest first", () => {
    assert.deepEqual(search("api"), [
      join(root, "work/api"),
      join(root, "work/api/packages/api-server"),
    ]);
  });

  /** The reason a search exists at all: the directory a Project walk refuses to offer. */
  it("reaches inside a repository, which discovery deliberately will not", () => {
    assert.deepEqual(search("packages"), [join(root, "work/api/packages")]);
  });

  it("matches on the path, so a query with a slash narrows the way it reads", () => {
    assert.deepEqual(search("work/web"), [join(root, "work/web")]);
  });

  it("never offers machine output, or anything hidden", () => {
    // Not stopping at repositories is what makes this list necessary — see NEVER_OFFERED.
    assert.deepEqual(search("left-pad"), []);
    assert.deepEqual(search("node_modules"), []);
    assert.deepEqual(search("dist"), []);
    assert.deepEqual(search("secret"), []);
  });

  it("answers nothing for an empty query, or with no root to search", () => {
    assert.deepEqual(search(""), []);
    assert.deepEqual(searchDirectories(undefined, "api").paths, []);
  });

  it("completes a path instead of searching, when the query starts with a slash", () => {
    const answer = searchDirectories(root, `${root}/wo`);
    assert.equal(answer.kind, "completion");
    assert.deepEqual(answer.paths, [join(root, "work")]);

    // A trailing slash lists everything in that directory — hidden ones included, because a path
    // typed in full is an explicit instruction rather than a guess.
    const all = searchDirectories(root, `${root}/`);
    assert.equal(all.kind, "completion");
    assert.ok(all.paths.includes(join(root, "notes")), "lists the children");
  });

  it("completes anywhere on disk, not only beneath the root", () => {
    // The root is irrelevant to a completion: the reader named an absolute path.
    const answer = searchDirectories(root, "/tm");
    assert.equal(answer.kind, "completion");
    assert.ok(answer.paths.includes("/tmp"), `expected /tmp among ${answer.paths.join(", ")}`);
  });

  it("reports which search ran, so the UI can say what it is showing", () => {
    assert.equal(searchDirectories(root, "api").kind, "search");
    assert.equal(searchDirectories(root, "~").kind, "completion");
    // `work/api` is a name, not a path: the rule is the first character, not "contains a slash".
    assert.equal(searchDirectories(root, "work/api").kind, "search");
  });

  it(`stops the search at ${MAX_SEARCH_DEPTH} levels`, () => {
    mkdirSync(join(root, "a/b/c/d/e/f/deep-target"), { recursive: true });
    assert.deepEqual(search("deep-target"), []);
  });
});
