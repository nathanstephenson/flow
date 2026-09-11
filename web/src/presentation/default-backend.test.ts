import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDefaultBackend } from "../../../src/protocol/settings.ts";

describe("the Default Backend shared by web and Session Host", () => {
  it("prefers the configured backend regardless of registry order", () => {
    assert.equal(resolveDefaultBackend(["claude", "pi"], "pi"), "pi");
  });

  it("uses Claude automatically, or the first available backend without Claude", () => {
    assert.equal(resolveDefaultBackend(["pi", "claude"]), "claude");
    assert.equal(resolveDefaultBackend(["pi", "fake"]), "pi");
    assert.equal(resolveDefaultBackend([]), undefined);
  });

  it("does not silently reroute an unavailable configured backend", () => {
    assert.equal(resolveDefaultBackend(["claude"], "pi"), "pi");
  });
});
