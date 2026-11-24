import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubLinkLabel } from "./github-link.ts";

describe("githubLinkLabel", () => {
  it("ignores links that are not GitHub", () => {
    assert.equal(githubLinkLabel("https://example.com/acme/web"), undefined);
    assert.equal(githubLinkLabel("https://gist.github.com/acme/1"), undefined);
    assert.equal(githubLinkLabel("not a url"), undefined);
  });

  it("shortens pull requests and issues to owner/repo#n", () => {
    assert.equal(githubLinkLabel("https://github.com/acme/web/pull/42"), "acme/web#42");
    assert.equal(githubLinkLabel("https://github.com/acme/web/pull/42/files#diff-1"), "acme/web#42");
    assert.equal(githubLinkLabel("https://www.github.com/acme/web/issues/7"), "acme/web#7");
  });

  it("shortens commits to owner/repo@sha", () => {
    assert.equal(githubLinkLabel("https://github.com/acme/web/commit/0123456789abcdef"), "acme/web@0123456");
  });

  it("keeps the path for other pages", () => {
    assert.equal(githubLinkLabel("https://github.com/acme"), "acme");
    assert.equal(githubLinkLabel("https://github.com/acme/web/"), "acme/web");
    assert.equal(githubLinkLabel("https://github.com/acme/web/blob/main/src/a.ts"), "acme/web/blob/main/src/a.ts");
    assert.equal(githubLinkLabel("https://github.com/"), "github.com");
  });
});
