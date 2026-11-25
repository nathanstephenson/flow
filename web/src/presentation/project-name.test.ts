import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectName } from "../../../src/client/project-name.ts";

describe("projectName", () => {
  it("names a Read-only Scope <chat>", () => {
    assert.equal(projectName("/home/u/code", undefined, true), "<chat>");
    assert.equal(projectName("/home/u/code"), "code");
  });
});
