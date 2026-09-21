import assert from "node:assert/strict";
import { test } from "node:test";

import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
import {
  OPEN_BROWSER_UPDATE_CHECK_MS,
  UPDATE_RECONNECT_LIMIT_MS,
  canStartUpdate,
  pollUpdateChecks,
  reconnectView,
  updatePresentation,
  type UpdateViewState,
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

test("reconnect polling survives repeated failures, observes host return, and stops", async () => {
  let active = true;
  let checks = 0;
  await pollUpdateChecks({
    active: () => active,
    delay: () => 2_000,
    wait: async delay => { assert.equal(delay, 2_000); },
    check: async () => {
      checks++;
      if (checks === 3) active = false;
    },
  });
  assert.equal(checks, 3, "two failed responses do not disarm the poll before the host returns");
});

test("reconnect polling reaches recovery-needed after repeated unreachable responses", async () => {
  let now = 0;
  let view: UpdateViewState = "reconnecting";
  await pollUpdateChecks({
    active: () => view === "reconnecting",
    delay: () => 10_000,
    wait: async delay => { now += delay; },
    check: async () => { view = reconnectView(0, now); },
  });
  assert.equal(now, UPDATE_RECONNECT_LIMIT_MS);
  assert.equal(view, "recovery-needed");
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

test("a newer release supersedes a persisted successful outcome after reload", () => {
  const successive: WebUpdateStatus = {
    installedVersion: "2.0.0",
    latestVersion: "3.0.0",
    updateAvailable: true,
    eligibility: { state: "eligible" },
    operation: {
      id: "prior",
      state: "succeeded",
      previousVersion: "1.0.0",
      targetVersion: "2.0.0",
      installedVersion: "2.0.0",
      startedAt: "then",
      finishedAt: "later",
    },
  };
  const presentation = updatePresentation(successive, "ready");
  assert.equal(presentation, "available");
  assert.equal(canStartUpdate(successive, presentation), true);
});
