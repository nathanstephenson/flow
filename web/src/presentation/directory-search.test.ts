import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { searchKind, worthSearching } from "./directory-search.ts";

/**
 * The one rule this restates from the daemon: which of the two searches a query gets.
 *
 * `searchDirectories` in src/daemon/projects.ts is the authority — it is the one that runs — but the
 * field has to label itself before the answer arrives. These cases are deliberately the same ones
 * asserted in test/projects-include.test.ts, so the copy cannot drift unnoticed.
 */
describe("which directory search a query gets", () => {
  it("treats a leading slash or tilde as a path to complete", () => {
    assert.equal(searchKind("/home/node/wo"), "completion");
    assert.equal(searchKind("/"), "completion");
    assert.equal(searchKind("~"), "completion");
    assert.equal(searchKind("~/workspace"), "completion");
    // Leading whitespace is a typing artefact, not a different intent.
    assert.equal(searchKind("  /tmp"), "completion");
  });

  it("treats anything else as a name to search for, slashes included", () => {
    assert.equal(searchKind("api"), "search");
    // The rule is the *first character*, not "contains a slash" — so `work/api` is still a name,
    // and still narrows to a nested directory.
    assert.equal(searchKind("work/api"), "search");
    assert.equal(searchKind("mono/packages"), "search");
  });

  it("has nothing to ask about an empty query, but a bare root is a real one", () => {
    assert.equal(worthSearching(""), false);
    assert.equal(worthSearching("   "), false);
    assert.equal(worthSearching("/"), true, "the children of / are a real answer");
    assert.equal(worthSearching("~"), true);
  });
});
