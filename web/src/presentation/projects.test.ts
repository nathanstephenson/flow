import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Project } from "../../../src/protocol/projects.ts";
import { groupProjects, includeEntryFor } from "./projects.ts";

const project = (name: string, group?: string): Project => ({
  path: `/w/${group === undefined ? "" : `${group}/`}${name}`,
  name,
  ...(group === undefined ? {} : { group }),
});

describe("arranging Projects for a dropdown", () => {
  it("puts the ungrouped ones in their own headingless group, first", () => {
    const groups = groupProjects([project("repo-a"), project("repo-b"), project("api", "work")]);

    assert.deepEqual(
      groups.map((entry) => [entry.group, entry.items.map((item) => item.name)]),
      [
        [undefined, ["repo-a", "repo-b"]],
        ["work", ["api"]],
      ],
    );
  });

  it("keeps a nested label whole rather than splitting it into levels", () => {
    // "work/backend" is one heading, not a "work" heading containing a "backend" one: a dropdown
    // draws one level, so the label carries the depth instead of the structure doing it.
    const groups = groupProjects([project("api", "work"), project("db", "work/backend")]);

    assert.deepEqual(groups.map((entry) => entry.group), ["work", "work/backend"]);
  });

  /**
   * The host sorts so that everything sharing a label is contiguous, and this trusts that rather
   * than re-sorting. If the two ever disagree, the same label appears twice — which is the visible
   * symptom this test describes.
   */
  it("opens a second group when a label reappears after another", () => {
    const groups = groupProjects([project("api", "work"), project("x", "play"), project("db", "work")]);

    assert.deepEqual(groups.map((entry) => entry.group), ["work", "play", "work"]);
  });

  it("has nothing to say about an empty list", () => {
    assert.deepEqual(groupProjects([]), []);
  });
});

describe("writing a Project into the include list", () => {
  it("writes a path beneath the Project Root as a relative entry", () => {
    assert.equal(includeEntryFor("/w/work/api", "/w"), "work/api");
    assert.equal(includeEntryFor("/w/solo", "/w"), "solo");
    // A trailing slash on the root is a typing artefact, not a different root.
    assert.equal(includeEntryFor("/w/solo", "/w/"), "solo");
  });

  it("leaves a path outside the Project Root absolute", () => {
    assert.equal(includeEntryFor("/elsewhere/thing", "/w"), "/elsewhere/thing");
    // Shares a textual prefix but is not inside it, which is why the comparison includes the slash.
    assert.equal(includeEntryFor("/workspace-old/api", "/workspace"), "/workspace-old/api");
  });

  it("leaves everything absolute when there is no Project Root", () => {
    assert.equal(includeEntryFor("/w/work/api", undefined), "/w/work/api");
    assert.equal(includeEntryFor("/w/work/api", ""), "/w/work/api");
  });

  it("leaves the Project Root itself absolute, since it relativises to nothing", () => {
    assert.equal(includeEntryFor("/w", "/w"), "/w");
  });
});
