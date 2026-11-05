import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ROUTE,
  formatRoute,
  parseRoute,
  SETTINGS_SECTIONS,
  type Route,
} from "./route.ts";

describe("deep links to an Agent Session", () => {
  it("reads the Agent Session a hash names", () => {
    assert.deepEqual(parseRoute("#/s/abc"), { sessionId: "abc" });
  });

  /**
   * An older build wrote a second id after the first. Those links are still in bookmarks and still
   * name something real, so the first id is honoured and the rest of the hash is dropped.
   */
  it("opens the first Agent Session named by a hash with trailing segments", () => {
    assert.equal(parseRoute("#/s/abc/split/def").sessionId, "abc");
    assert.equal(parseRoute("#/s/abc/anything/at/all").sessionId, "abc");
  });

  it("ignores a hash that names no Agent Session", () => {
    for (const hash of ["", "#", "#/", "#/s", "#/s/", "#/nope/abc"]) {
      assert.deepEqual(parseRoute(hash), DEFAULT_ROUTE, hash);
    }
  });

  it("survives a hand-edited hash with a stray percent", () => {
    assert.equal(parseRoute("#/s/%").sessionId, undefined);
  });

  it("round-trips an id that needs escaping", () => {
    const sessionId = "scope/with a space";
    const hash = formatRoute({ sessionId });
    assert.equal(hash.includes(" "), false);
    assert.equal(parseRoute(hash).sessionId, sessionId);
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
  it("reads every section beside the Agent Session", () => {
    for (const section of SETTINGS_SECTIONS) {
      assert.deepEqual(parseRoute(`#/s/abc?settings=${section}`), { sessionId: "abc", settings: section });
    }
  });

  it("reads a section beside the New Agent Session view", () => {
    assert.deepEqual(parseRoute("#/new/codex?settings=mcp"), {
      sessionId: undefined,
      backend: "codex",
      settings: "mcp",
    });
    assert.deepEqual(parseRoute("#/?settings=mcp"), { sessionId: undefined, settings: "mcp" });
  });

  /** Sections get renamed; bookmarks do not. "The Settings, at the top" is always a useful answer. */
  it("lands on the first section when the named one is gone", () => {
    assert.equal(parseRoute("#/s/abc?settings=typography").settings, "general");
    assert.equal(parseRoute("#/s/abc?settings=%").settings, "general");
    assert.equal(parseRoute("#/s/abc?settings=").settings, "general");
  });

  /** Old bookmarks and the MCP OAuth return use this form. */
  it("reads the old Settings hash as the Settings over no Agent Session", () => {
    assert.deepEqual(parseRoute("#/settings/mcp"), { sessionId: undefined, settings: "mcp" });
    assert.deepEqual(parseRoute("#/settings"), { sessionId: undefined, settings: "general" });
    assert.deepEqual(parseRoute("#/settings/typography"), { sessionId: undefined, settings: "general" });
  });

  it("round-trips every section with each kind of route", () => {
    for (const settings of SETTINGS_SECTIONS) {
      const routes: Route[] = [
        { sessionId: "scope/with a space", settings },
        { sessionId: undefined, backend: "codex", settings },
        { sessionId: undefined, settings },
      ];
      for (const route of routes) assert.deepEqual(parseRoute(formatRoute(route)), route);
    }
  });

  it("keeps the Agent Session part of the hash", () => {
    assert.equal(formatRoute({ sessionId: "abc", settings: "keyboard" }), "#/s/abc?settings=keyboard");
    assert.equal(formatRoute({ sessionId: undefined, settings: "keyboard" }), "#/?settings=keyboard");
  });
});
