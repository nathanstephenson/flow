import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearRetainedWorkflowLaunch,
  retainWorkflowLaunch,
  retainedWorkflowLaunch,
  pruneRetainedWorkflowLaunch,
} from "./workflow-launch.ts";

describe("a workflow launch retained after Agent Session creation", () => {
  it("keeps validated inputs for retry against the same Agent Session", () => {
    retainWorkflowLaunch("session-a", {
      launchId: "launch-a",
      workflowId: "release",
      input: { target: "production" },
      error: "Runtime unavailable",
    });
    assert.deepEqual(retainedWorkflowLaunch("session-a"), {
      launchId: "launch-a",
      workflowId: "release",
      input: { target: "production" },
      error: "Runtime unavailable",
    });
    assert.equal(retainedWorkflowLaunch("session-b"), undefined);
  });

  it("prunes launches whose Agent Session disappeared", () => {
    retainWorkflowLaunch("session-a", { launchId: "launch-a", workflowId: "release", input: {}, error: "failed" });
    retainWorkflowLaunch("session-b", { launchId: "launch-b", workflowId: "release", input: {}, error: "failed" });
    pruneRetainedWorkflowLaunch(new Set(["session-b"]));
    assert.equal(retainedWorkflowLaunch("session-a"), undefined);
    assert.ok(retainedWorkflowLaunch("session-b"));
  });

  it("clears only after retry succeeds", () => {
    retainWorkflowLaunch("session-a", { launchId: "launch-a", workflowId: "release", input: {}, error: "failed" });
    clearRetainedWorkflowLaunch("session-a");
    assert.equal(retainedWorkflowLaunch("session-a"), undefined);
  });
});
