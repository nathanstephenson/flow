import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearRetainedWorkflowLaunch,
  retainWorkflowLaunch,
  retainedWorkflowLaunch,
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

  it("clears only after retry succeeds", () => {
    retainWorkflowLaunch("session-a", { launchId: "launch-a", workflowId: "release", input: {}, error: "failed" });
    clearRetainedWorkflowLaunch("session-a");
    assert.equal(retainedWorkflowLaunch("session-a"), undefined);
  });
});
