import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { resolvePullRequest, resolveRepository } from "../src/daemon/repository.ts";
import { gh, type Gh } from "../src/daemon/github.ts";

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
  id: "PR_open", number: 7, url: "https://github.com/base/repo/pull/7", title: "Change", baseRefName: "main", headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headRefName: "feature", state: "OPEN", isDraft: false, reviewDecision: null,
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
      repo: "base/repo", id: "PR_open", number: 7, url: "https://github.com/base/repo/pull/7", title: "Change", baseBranch: "main", headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headRefName: "feature", headRepository: { id: "R_fork" }, state: "OPEN",
      isDraft: true, checks: "passing", checksCompleted: 0, reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, updatedAt: "2025-01-01",
    });
    const checks = async (rollup: unknown) => (await resolvePullRequest(repo, resolved, "feature", github([pull({ commits: { nodes: rollup === undefined ? [] : [{ commit: { statusCheckRollup: rollup } }] } })]).run))?.checks;
    assert.equal(await checks({ state: "FAILURE" }), "failing");
    assert.equal(await checks({ state: "ERROR" }), "failing");
    assert.equal(await checks({ state: "PENDING" }), "pending");
    assert.equal(await checks({ state: "EXPECTED" }), "pending");
    assert.equal(await checks(null), "none");
    assert.equal(await checks(undefined), "none");
    const contexts = { checkRunCountsByState: [{ state: "SUCCESS", count: 2 }, { state: "IN_PROGRESS", count: 1 }, { state: "QUEUED", count: 3 }, { state: "FAILURE", count: 1 }, { state: "WAITING", count: 1 }, { state: "PENDING", count: 1 }], statusContextCountsByState: [{ state: "PENDING", count: 1 }, { state: "EXPECTED", count: 2 }, { state: "ERROR", count: 1 }] };
    const completed = await resolvePullRequest(repo, resolved, "feature", github([pull({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts } } }] } })]).run);
    assert.equal(completed?.checksCompleted, 4);
  });
});

describe("gh", () => {
  it("distinguishes missing gh, authentication failure and request failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-gh-"));
    const path = process.env.PATH;
    const bin = join(root, "bin");
    mkdirSync(bin);
    const fake = (script: string) => { writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, "gh"), 0o755); };
    process.env.PATH = bin;
    try {
      await assert.rejects(gh(root, ["auth", "status"]), /CLI is missing/);
      fake("echo 'not logged in' >&2\nexit 1");
      await assert.rejects(gh(root, ["auth", "status"]), /authentication failed/);
      await assert.rejects(gh(root, ["pr", "list"]), /request failed/);
      fake("echo 'HTTP 503 unavailable' >&2\nexit 1");
      await assert.rejects(gh(root, ["auth", "status"]), /request failed/);
    } finally {
      process.env.PATH = path;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
