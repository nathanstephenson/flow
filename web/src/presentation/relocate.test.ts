import assert from "node:assert/strict";
import { it } from "node:test";

import { suggestedRepository } from "./relocate.ts";

const projects = [
  { path: "/Users/me/repos/pbp-api", name: "pbp-api" },
  { path: "/Users/me/repos/platform", name: "platform" },
];

it("suggests the Project named like the Worktree's repository", () => {
  assert.equal(suggestedRepository("/home/node/.flow/worktrees/pbp-api/main-42520008", projects), "/Users/me/repos/pbp-api");
});

it("suggests nothing when no Project has that name", () => {
  assert.equal(suggestedRepository("/home/node/.flow/worktrees/other/main-1", projects), undefined);
  assert.equal(suggestedRepository("/home/node/workspace/platform", projects), undefined);
});
