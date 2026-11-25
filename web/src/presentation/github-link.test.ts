import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubLinkLabel, samePullRequest } from "./github-link.ts";

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

describe("samePullRequest", () => {
  const pr = "https://github.com/acme/web/pull/42";

  it("matches any page of the same pull request", () => {
    assert.equal(samePullRequest("https://github.com/acme/web/pull/42", pr), true);
    assert.equal(samePullRequest("https://www.github.com/Acme/Web/pull/42/files#diff-1", pr), true);
  });

  it("rejects other pull requests, issues and pages", () => {
    assert.equal(samePullRequest("https://github.com/acme/web/pull/43", pr), false);
    assert.equal(samePullRequest("https://github.com/acme/api/pull/42", pr), false);
    assert.equal(samePullRequest("https://github.com/acme/web/issues/42", pr), false);
    assert.equal(samePullRequest("https://github.com/acme/web", pr), false);
    assert.equal(samePullRequest("not a url", pr), false);
  });
});
