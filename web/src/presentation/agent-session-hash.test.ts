import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatAgentSessionHash, parseAgentSessionHash } from "./agent-session-hash.ts";

describe("deep links to an Agent Session", () => {
  it("reads the Agent Session a hash names", () => {
    assert.equal(parseAgentSessionHash("#/s/abc"), "abc");
  });

  /**
   * An older build wrote a second id after the first. Those links are still in bookmarks and still
   * name something real, so the first id is honoured and the rest of the hash is dropped.
   */
  it("opens the first Agent Session named by a hash with trailing segments", () => {
    assert.equal(parseAgentSessionHash("#/s/abc/split/def"), "abc");
    assert.equal(parseAgentSessionHash("#/s/abc/anything/at/all"), "abc");
  });

  it("ignores a hash that names no Agent Session", () => {
    for (const hash of ["", "#", "#/", "#/s", "#/s/", "#/nope/abc"]) {
      assert.equal(parseAgentSessionHash(hash), undefined, hash);
    }
  });

  it("survives a hand-edited hash with a stray percent", () => {
    assert.equal(parseAgentSessionHash("#/s/%"), undefined);
  });

  it("round-trips an id that needs escaping", () => {
    const id = "scope/with a space";
    const hash = formatAgentSessionHash(id);
    assert.equal(hash.includes(" "), false);
    assert.equal(parseAgentSessionHash(hash), id);
  });

  /**
   * The hash is written only when it differs from the one in the bar, which is what stops the write
   * and the `hashchange` listener from chasing each other. That comparison is a string compare, so
   * formatting has to be stable for the same selection — and empty when there is none, so the URL
   * of a fresh app stays clean.
   */
  it("writes nothing when nothing is focused", () => {
    assert.equal(formatAgentSessionHash(undefined), "");
  });
});
