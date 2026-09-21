import assert from "node:assert/strict";
import { test } from "node:test";

import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
import {
  OPEN_BROWSER_UPDATE_CHECK_MS,
  UPDATE_RECONNECT_LIMIT_MS,
  canStartUpdate,
  reconnectView,
  updateDetail,
  updatePresentation,
} from "./update.ts";

const base: WebUpdateStatus = {
  installedVersion: "1.0.0",
  latestVersion: "2.0.0",
  updateAvailable: true,
  eligibility: { state: "eligible" },
};

test("an open browser checks hourly and response loss progresses from reconnecting to recovery guidance", () => {
  assert.equal(OPEN_BROWSER_UPDATE_CHECK_MS, 60 * 60 * 1000);
  assert.equal(UPDATE_RECONNECT_LIMIT_MS, 30 * 1000);
  assert.equal(reconnectView(1_000, 1_000), "reconnecting");
  assert.equal(reconnectView(1_000, 30_999), "reconnecting");
  assert.equal(reconnectView(1_000, 31_000), "recovery-needed");
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
  assert.equal(updatePresentation({ ...base, updateAvailable: false, operation: { id: "1", state: "succeeded", previousVersion: "1.0.0", installedVersion: "2.0.0", startedAt: "then" } }, "ready"), "success");
  assert.equal(updatePresentation({ ...base, operation: { id: "1", state: "failed", previousVersion: "1.0.0", startedAt: "then" } }, "ready"), "failure");
  assert.equal(updatePresentation({ ...base, operation: { id: "1", state: "unverified", previousVersion: "1.0.0", startedAt: "then" } }, "ready"), "recovery-needed");
  assert.equal(updatePresentation(base, "recovery-needed"), "recovery-needed");
  assert.equal(updatePresentation({ ...base, checkError: "registry down" }, "ready"), "error");
});

const priorSuccess = {
  id: "prior",
  state: "succeeded" as const,
  previousVersion: "1.0.0",
  targetVersion: "2.0.0",
  installedVersion: "2.0.0",
  startedAt: "then",
  finishedAt: "later",
};

function successive(eligibility: WebUpdateStatus["eligibility"]): WebUpdateStatus {
  return {
    installedVersion: "2.0.0",
    latestVersion: "3.0.0",
    updateAvailable: true,
    eligibility,
    operation: priorSuccess,
  };
}

test("a newer eligible release supersedes a persisted successful outcome after reload", () => {
  const status = successive({ state: "eligible" });
  const presentation = updatePresentation(status, "ready");
  assert.equal(presentation, "available");
  assert.equal(canStartUpdate(status, presentation), true);
});

test("a successive release surfaces current blocked and unsupported eligibility before prior success", () => {
  for (const [eligibility, expected, reason] of [
    [{ state: "blocked", reason: "Active work is running." }, "blocked", "Active work is running."],
    [{ state: "unsupported", reason: "Source installations update manually." }, "unsupported", "Source installations update manually."],
  ] as const) {
    const status = successive(eligibility);
    const presentation = updatePresentation(status, "ready");
    assert.equal(presentation, expected);
    assert.equal(canStartUpdate(status, presentation), false);
    const detail = updateDetail(presentation, status);
    assert.match(detail, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(detail, /previous update to Flow 2\.0\.0 was verified successfully/i);
  }
});

test("locally timed-out recovery always renders reconnect and manual-repair guidance", () => {
  const status: WebUpdateStatus = {
    ...base,
    operation: {
      id: "active",
      state: "updating",
      previousVersion: "1.0.0",
      targetVersion: "2.0.0",
      startedAt: "then",
      message: "Starting the guarded npm update.",
    },
  };
  const presentation = updatePresentation(status, "recovery-needed", "Failed to fetch");
  assert.equal(presentation, "recovery-needed");
  const detail = updateDetail(presentation, status, { transportError: "Failed to fetch" });
  assert.match(detail, /Reconnect below/);
  assert.match(detail, /repair the private global npm installation manually and restart it/);
  assert.match(detail, /Last known update status: Starting the guarded npm update/);
});
