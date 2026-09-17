import assert from "node:assert/strict";
import { it } from "node:test";
import { pollAfterInitialLoad } from "./workflow-transcript-polling.ts";

it("runs the requested final catch-up when completion occurs during initial tail loading", () => {
  let completed = false;
  let catchUpRequested = false;

  // The completion effect runs while the initial request is still pending.
  completed = true;
  catchUpRequested = true;

  assert.equal(pollAfterInitialLoad(completed, catchUpRequested), true);
});

it("does not poll a completed transcript after its final catch-up", () => {
  assert.equal(pollAfterInitialLoad(true, false), false);
  assert.equal(pollAfterInitialLoad(false, false), true);
});
