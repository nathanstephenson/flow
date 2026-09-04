import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scopeKindHint, scopeKindLabel } from "../../../src/client/scope-kind.ts";

/**
 * The wording both front-ends say about a Scope.
 *
 * Tested here for the reason `contextUsageLabel` is shared at all: this is one phrase two clients
 * have to agree on, and the last time wording like it lived in two places the two places drifted.
 */
describe("what a Scope is called", () => {
  it("names a Worktree as one", () => {
    assert.equal(scopeKindLabel({ worktree: true }), "Worktree");
  });

  // "Local checkout" would contrast with a remote one, and GoodHarness has no such thing — so it
  // would distinguish nothing now and be wrong on the day it does.
  it("calls an ordinary Scope the Project's checkout, not a local one", () => {
    assert.equal(scopeKindLabel({}), "Project checkout");
    assert.doesNotMatch(scopeKindLabel({}), /local/i);
  });

  // The hint is the whole reason the checkout is a label and the branch is a picker.
  it("says a Scope cannot be changed, whichever kind it is", () => {
    for (const scope of [{ worktree: true } as const, {}]) {
      assert.match(scopeKindHint(scope), /whole life/);
    }
  });
});
