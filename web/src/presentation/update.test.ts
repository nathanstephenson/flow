import assert from "node:assert/strict";
import { test } from "node:test";

import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
import { OPEN_BROWSER_UPDATE_CHECK_MS, UPDATE_RECONNECT_LIMIT_MS, updatePresentation } from "./update.ts";

const base: WebUpdateStatus = {
  installedVersion: "1.0.0",
  latestVersion: "2.0.0",
  updateAvailable: true,
  eligibility: { state: "eligible" },
};

test("an open browser checks hourly and stops presenting reconnect as endless progress", () => {
  assert.equal(OPEN_BROWSER_UPDATE_CHECK_MS, 60 * 60 * 1000);
  assert.equal(UPDATE_RECONNECT_LIMIT_MS, 30 * 1000);
});

test("update presentation distinguishes every discovery, eligibility, lifecycle, and recovery outcome", () => {
  assert.equal(updatePresentation(undefined, "checking"), "checking");
  assert.equal(updatePresentation(base, "checking"), "checking");
  assert.equal(updatePresentation({ ...base, updateAvailable: false }, "ready"), "up-to-date");
  assert.equal(updatePresentation(base, "ready"), "available");
  assert.equal(updatePresentation({ ...base, eligibility: { state: "unsupported", reason: "source" } }, "ready"), "unsupported");
  assert.equal(updatePresentation({ ...base, eligibility: { state: "blocked", reason: "active" } }, "ready"), "blocked");
  assert.equal(updatePresentation(base, "starting"), "updating");
  assert.equal(updatePresentation({ ...base, operation: { id: "1", state: "updating", previousVersion: "1.0.0", startedAt: "now" } }, "ready"), "updating");
  assert.equal(updatePresentation(base, "reconnecting"), "reconnecting");
  assert.equal(updatePresentation({ ...base, operation: { id: "1", state: "succeeded", previousVersion: "1.0.0", installedVersion: "2.0.0", startedAt: "then" } }, "ready"), "success");
  assert.equal(updatePresentation({ ...base, operation: { id: "1", state: "failed", previousVersion: "1.0.0", startedAt: "then" } }, "ready"), "failure");
  assert.equal(updatePresentation({ ...base, operation: { id: "1", state: "unverified", previousVersion: "1.0.0", startedAt: "then" } }, "ready"), "recovery-needed");
  assert.equal(updatePresentation(base, "recovery-needed"), "recovery-needed");
  assert.equal(updatePresentation({ ...base, checkError: "registry down" }, "ready"), "error");
});
