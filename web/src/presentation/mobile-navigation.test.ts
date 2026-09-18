import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultLayout, fillWithGit } from "./docks.ts";
import {
  historyWithMobileView,
  MOBILE_TRANSCRIPT,
  mobileViewFromHistory,
  sameMobileView,
  validMobileView,
  type MobileView,
} from "./mobile-navigation.ts";

describe("mobile Agent Session history", () => {
  const git: MobileView = { kind: "dock", side: "right", tabId: "git" };

  it("round-trips a tab while retaining unrelated history state", () => {
    const state = historyWithMobileView({ another: 1 }, "session", git);
    assert.equal((state as { another: number }).another, 1);
    assert.deepEqual(mobileViewFromHistory(state, "session"), git);
  });

  it("does not carry a tab from one Agent Session into another", () => {
    const state = historyWithMobileView(null, "first", git);
    assert.deepEqual(mobileViewFromHistory(state, "second"), MOBILE_TRANSCRIPT);
  });

  it("round-trips nested detail destinations", () => {
    const detail: MobileView = {
      kind: "dock",
      side: "right",
      tabId: "workflow",
      detail: { kind: "workflow-step", id: "build" },
    };
    assert.deepEqual(mobileViewFromHistory(historyWithMobileView({}, "s", detail), "s"), detail);
  });

  it("falls back to Transcript for malformed history", () => {
    for (const state of [null, {}, { flowMobileView: 1 }, { flowMobileView: { sessionId: "s", view: { kind: "dock" } } }]) {
      assert.deepEqual(mobileViewFromHistory(state, "s"), MOBILE_TRANSCRIPT);
    }
  });

  it("falls back to Transcript when a historical tab has been closed", () => {
    const layout = defaultLayout();
    assert.deepEqual(validMobileView(git, layout), MOBILE_TRANSCRIPT);
    const open = { ...layout, right: fillWithGit(layout.right, "git") };
    assert.deepEqual(validMobileView(git, open), git);
  });

  it("compares nested destinations rather than only their tabs", () => {
    assert.equal(sameMobileView(git, { ...git }), true);
    assert.equal(
      sameMobileView(
        { ...git, detail: { kind: "subagent", id: "one" } },
        { ...git, detail: { kind: "subagent", id: "two" } },
      ),
      false,
    );
  });
});
