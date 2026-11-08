import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Project } from "../../../src/protocol/projects.ts";
import { sessionProject } from "./session-project.ts";

const projects = [
  { path: "/code/flow", name: "flow" },
  { path: "/code/api", name: "api" },
] as Project[];

describe("the Project an Agent Session belongs to", () => {
  it("is the Project at its Scope", () => {
    assert.equal(sessionProject({ scope: "/code/api" }, projects)?.path, "/code/api");
  });

  it("is the Project named by a worktree Scope's repository", () => {
    assert.equal(sessionProject({ scope: "/home/me/.flow/worktrees/flow/main-1", worktree: true }, projects)?.path, "/code/flow");
  });

  it("is absent for a Scope that is not a listed Project", () => {
    assert.equal(sessionProject({ scope: "/tmp/elsewhere" }, projects), undefined);
  });
});
