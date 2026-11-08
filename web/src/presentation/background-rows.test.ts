import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backgroundKeyOf, foldBackgroundCalls } from "./background-rows.ts";

describe("a Background Call and the tool call that launched it", () => {
  it("are one row where the tool row is shown", () => {
    assert.deepEqual(foldBackgroundCalls(["tool:a", "background_call:a", "assistant:1"]), ["tool:a", "assistant:1"]);
  });

  it("keep the Background Call's row when its tool row is not shown", () => {
    assert.deepEqual(foldBackgroundCalls(["background_call:a", "tool:b"]), ["background_call:a", "tool:b"]);
  });

  it("returns the same list when there is nothing to fold", () => {
    const keys = ["tool:a", "assistant:1"];
    assert.equal(foldBackgroundCalls(keys), keys);
  });

  it("names the Background Call key of a tool key", () => {
    assert.equal(backgroundKeyOf("tool:a"), "background_call:a");
    assert.equal(backgroundKeyOf("assistant:1"), "");
  });
});
