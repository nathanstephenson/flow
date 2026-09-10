import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ROUTE,
  formatRoute,
  parseRoute,
  routedSessionId,
  SETTINGS_SECTIONS,
  type Route,
  returnPoint,
} from "./route.ts";

describe("deep links to an Agent Session", () => {
  it("reads the Agent Session a hash names", () => {
    assert.deepEqual(parseRoute("#/s/abc"), { view: "session", sessionId: "abc" });
  });

  /**
   * An older build wrote a second id after the first. Those links are still in bookmarks and still
   * name something real, so the first id is honoured and the rest of the hash is dropped.
   */
  it("opens the first Agent Session named by a hash with trailing segments", () => {
    assert.equal(routedSessionId(parseRoute("#/s/abc/split/def")), "abc");
    assert.equal(routedSessionId(parseRoute("#/s/abc/anything/at/all")), "abc");
  });

  it("ignores a hash that names no Agent Session", () => {
    for (const hash of ["", "#", "#/", "#/s", "#/s/", "#/nope/abc"]) {
      assert.deepEqual(parseRoute(hash), DEFAULT_ROUTE, hash);
    }
  });

  it("survives a hand-edited hash with a stray percent", () => {
    assert.equal(routedSessionId(parseRoute("#/s/%")), undefined);
  });

  it("round-trips an id that needs escaping", () => {
    const sessionId = "scope/with a space";
    const hash = formatRoute({ view: "session", sessionId });
    assert.equal(hash.includes(" "), false);
    assert.equal(routedSessionId(parseRoute(hash)), sessionId);
  });

  /**
   * The hash is written only when it differs from the one in the bar, which is what stops the write
   * and the `hashchange` listener from chasing each other. That comparison is a string compare, so
   * formatting has to be stable for the same selection — and empty when there is none, so the URL
   * of a fresh app stays clean.
   */
  it("writes nothing when nothing is focused", () => {
    assert.equal(formatRoute(DEFAULT_ROUTE), "");
  });
});

describe("deep links to the Settings", () => {
  it("reads every section", () => {
    for (const section of SETTINGS_SECTIONS) {
      assert.deepEqual(parseRoute(`#/settings/${section}`), { view: "settings", section });
    }
  });

  it("lands on the first section when none is named", () => {
    assert.deepEqual(parseRoute("#/settings"), { view: "settings", section: "general" });
    assert.deepEqual(parseRoute("#/settings/"), { view: "settings", section: "general" });
  });

  /** Sections get renamed; bookmarks do not. "The Settings, at the top" is always a useful answer. */
  it("lands on the first section when the named one is gone", () => {
    assert.deepEqual(parseRoute("#/settings/typography"), { view: "settings", section: "general" });
    assert.deepEqual(parseRoute("#/settings/%"), { view: "settings", section: "general" });
  });

  it("round-trips every section", () => {
    for (const section of SETTINGS_SECTIONS) {
      const route: Route = { view: "settings", section };
      assert.deepEqual(parseRoute(formatRoute(route)), route);
    }
  });

  /**
   * The Settings are machine-wide, so no route may imply they belong to one Agent Session — a URL
   * that said otherwise would be a lie about their scope (src/protocol/settings.ts).
   */
  it("names no Agent Session", () => {
    assert.equal(routedSessionId(parseRoute("#/settings/appearance")), undefined);
    assert.equal(formatRoute({ view: "settings", section: "general" }).includes("/s/"), false);
  });
});

/**
 * Where leaving the Settings comes back to.
 *
 * The case worth pinning is the one that shipped broken: the New Agent Session view is the Agent
 * Session route naming none, so `undefined` has to be remembered as a real destination. Recording
 * only defined ids sent a reader who pressed `?` mid-message to an unrelated transcript.
 */
describe("the place leaving the Settings returns to", () => {
  it("remembers the Agent Session on screen", () => {
    assert.equal(returnPoint({ view: "session", sessionId: "abc" }, undefined), "abc");
  });

  it("remembers the New Agent Session view, which names no Agent Session", () => {
    assert.equal(returnPoint({ view: "session", sessionId: undefined }, "abc"), undefined);
  });

  it("leaves the last answer standing while the Settings are on screen", () => {
    assert.equal(returnPoint({ view: "settings", section: "keyboard" }, "abc"), "abc");
    assert.equal(returnPoint({ view: "settings", section: "keyboard" }, undefined), undefined);
  });
});
