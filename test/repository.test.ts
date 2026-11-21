import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { resolvePullRequest, resolveRepository } from "../src/daemon/repository.ts";
import type { Gh } from "../src/daemon/github.ts";

const repositories: Record<string, unknown> = {
  "test/origin": { id: "R_origin", defaultBranchRef: { name: "main" }, isFork: false },
  "test/other": { id: "R_other", defaultBranchRef: { name: "main" }, isFork: false },
  "test/third": { id: "R_third", defaultBranchRef: { name: "main" }, isFork: false },
  "fork/repo": { id: "R_fork", defaultBranchRef: { name: "main" }, isFork: true, parent: { id: "R_base", name: "repo", owner: { login: "base" } } },
  "old-owner/old-name": { id: "R_fork", defaultBranchRef: { name: "main" }, isFork: true, parent: { id: "R_base", name: "repo", owner: { login: "base" } } },
  "base/repo": { id: "R_base", defaultBranchRef: { name: "develop" }, isFork: false },
};

function github(pulls: unknown[] = []): { calls: string[][]; run: Gh } {
  const calls: string[][] = [];
  return { calls, run: async (_scope, args) => {
    calls.push(args);
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify(repositories[args[2]!]);
    return JSON.stringify({ data: { repository: { pullRequests: { nodes: pulls } } } });
  } };
}

const pull = (values: Record<string, unknown>) => ({
  id: "PR_open", number: 7, url: "https://github.com/base/repo/pull/7", title: "Change", baseRefName: "main", state: "OPEN", isDraft: false, reviewDecision: null,
  updatedAt: "2025-01-01", closedAt: null, headRepository: { id: "R_fork" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, reviewThreads: { nodes: [] }, ...values,
});

let root: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flow-repository-"));
  repo = repository(root, "repo");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveRepository", () => {
  it("chooses the push remote in the documented order", async () => {
    git(repo, "remote", "add", "origin", "git@github.com:test/origin.git");
    git(repo, "remote", "add", "other", "https://github.com/test/other.git");
    git(repo, "remote", "add", "third", "ssh://git@github.com/test/third.git");
    const resolved = async () => (await resolveRepository(repo, "main", github().run)).remote;
    assert.equal(await resolved(), "origin");
    git(repo, "config", "branch.main.remote", ".");
    assert.equal(await resolved(), "origin");
    git(repo, "config", "branch.main.remote", "other");
    assert.equal(await resolved(), "other");
    git(repo, "config", "remote.pushDefault", "third");
    assert.equal(await resolved(), "third");
    git(repo, "config", "branch.main.pushRemote", "other");
    assert.equal(await resolved(), "other");
    assert.equal((await resolveRepository(repo, undefined, github().run)).remote, "third");
  });

  it("uses a sole remote and refuses when no remote can be chosen", async () => {
    await assert.rejects(resolveRepository(repo, "main", github().run), /No remote/);
    git(repo, "remote", "add", "upstream", "git@github.com:test/other.git");
    assert.deepEqual(await resolveRepository(repo, "main", github().run), {
      remote: "upstream", url: "git@github.com:test/other.git",
      head: { repo: "test/other", id: "R_other" }, base: { repo: "test/other", id: "R_other", defaultBranch: "main" },
    });
    git(repo, "remote", "add", "second", "git@github.com:test/third.git");
    await assert.rejects(resolveRepository(repo, "main", github().run), /Cannot identify the push remote/);
  });

  it("uses the parent of a fork as the base repository", async () => {
    git(repo, "remote", "add", "origin", "git@github.com:fork/repo.git");
    const resolved = await resolveRepository(repo, "main", github().run);
    assert.deepEqual(resolved.head, { repo: "fork/repo", id: "R_fork" });
    assert.deepEqual(resolved.base, { repo: "base/repo", id: "R_base", defaultBranch: "develop" });
  });

  it("uses the push URL and refuses repositories outside github.com", async () => {
    git(repo, "remote", "add", "origin", "https://github.com/base/repo.git");
    git(repo, "config", "remote.origin.pushurl", "git@github.com:fork/repo.git");
    assert.equal((await resolveRepository(repo, "main", github().run)).head.repo, "fork/repo");
    git(repo, "config", "remote.origin.pushurl", "https://gitlab.com/test/origin.git");
    await assert.rejects(resolveRepository(repo, "main", github().run), /not a supported github.com/);
  });

  it("caches repository identity per Scope, remote and push URL", async () => {
    git(repo, "remote", "add", "origin", "git@github.com:fork/repo.git");
    const mock = github();
    await resolveRepository(repo, "main", mock.run);
    await resolveRepository(repo, "main", mock.run);
    assert.equal(mock.calls.filter(args => args[0] === "repo").length, 2);
    git(repo, "remote", "set-url", "origin", "git@github.com:test/origin.git");
    await resolveRepository(repo, "main", mock.run);
    assert.equal(mock.calls.filter(args => args[0] === "repo").length, 3);
  });
});

describe("resolvePullRequest", () => {
  let resolved: Awaited<ReturnType<typeof resolveRepository>>;
  beforeEach(async () => {
    git(repo, "remote", "add", "origin", "git@github.com:fork/repo.git");
    git(repo, "remote", "add", "upstream", "https://github.com/base/repo.git");
    resolved = await resolveRepository(repo, "feature", github().run);
  });

  it("prefers an open pull request and excludes other head repositories", async () => {
    const closed = { state: "CLOSED", updatedAt: "2026-01-02", closedAt: "2026-01-02" };
    const mock = github([pull({ ...closed, id: "foreign", headRepository: { id: "R_other" } }), pull({ ...closed, id: "closed" }), pull({ id: "selected" }), pull({ id: "other-open", headRepository: { id: "R_other" } })]);
    assert.equal((await resolvePullRequest(repo, resolved, "feature", mock.run))?.id, "selected");
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0]!.join(" "), /owner=base .*name=repo .*branch=feature/);
  });

  it("chooses the latest closed pull request when none is open", async () => {
    const latest = github([pull({ state: "CLOSED", id: "older", closedAt: "2024-01-01", updatedAt: "2026-02-01" }), pull({ state: "MERGED", id: "latest", closedAt: "2026-01-02" })]);
    assert.equal((await resolvePullRequest(repo, resolved, "feature", latest.run))?.id, "latest");
    assert.equal(await resolvePullRequest(repo, resolved, "feature", github().run), undefined);
  });

  it("matches the head repository by ID after a rename", async () => {
    git(repo, "remote", "set-url", "origin", "git@github.com:old-owner/old-name.git");
    const renamed = await resolveRepository(repo, "feature", github().run);
    assert.equal((await resolvePullRequest(repo, renamed, "feature", github([pull({})]).run))?.id, "PR_open");
  });

  it("summarises checks, review and unresolved threads", async () => {
    const threads = { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] };
    assert.deepEqual(await resolvePullRequest(repo, resolved, "feature", github([pull({ isDraft: true, reviewDecision: "CHANGES_REQUESTED", reviewThreads: threads })]).run), {
      repo: "base/repo", id: "PR_open", number: 7, url: "https://github.com/base/repo/pull/7", title: "Change", baseBranch: "main", state: "OPEN",
      isDraft: true, checks: "passing", reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, updatedAt: "2025-01-01",
    });
    const checks = async (rollup: unknown) => (await resolvePullRequest(repo, resolved, "feature", github([pull({ commits: { nodes: rollup === undefined ? [] : [{ commit: { statusCheckRollup: rollup } }] } })]).run))?.checks;
    assert.equal(await checks({ state: "FAILURE" }), "failing");
    assert.equal(await checks({ state: "ERROR" }), "failing");
    assert.equal(await checks({ state: "PENDING" }), "pending");
    assert.equal(await checks({ state: "EXPECTED" }), "pending");
    assert.equal(await checks(null), "none");
    assert.equal(await checks(undefined), "none");
  });
});
