import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository, unbornRepository } from "./git-fixture.ts";
import { gitStatus, snapshot, target, branchChanges, publish, gh, type Gh } from "../src/daemon/publish.ts";
import { summarisePublish } from "../src/daemon/summariser.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import type { PublishInput, PullRequest } from "../src/protocol/publish.ts";

const text = { commitMessage: "Add reviewed files", title: "Add reviewed files", body: "Changes for review." };
const input: PublishInput = { ...text, token: "test", branch: "feature/test" };
const pr: PullRequest = { number: 1, url: "https://github.com/test/repo/pull/1", title: "Existing", isDraft: true, reviewDecision: "APPROVED", statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }] };

function github(options: { pr?: PullRequest; repoId?: string | null; headRepository?: { id?: string; nameWithOwner?: string } | null; fork?: boolean; createError?: boolean; branchExists?: boolean } = {}): { calls: string[][]; run: Gh } {
  const calls: string[][] = [];
  return { calls, run: async (_scope, args) => {
    calls.push(args);
    if (args[0] === "auth") return "";
    if (args[0] === "api") return JSON.stringify(options.branchExists ? [{ ref: "refs/heads/feature/test" }] : []);
    if (args[0] === "repo") return JSON.stringify({ id: options.repoId === undefined ? "R_repo" : options.repoId, defaultBranchRef: { name: "main" }, isFork: options.fork ?? false });
    if (args[1] === "list") return JSON.stringify(options.pr ? [{ ...options.pr, headRepository: options.headRepository === undefined ? { id: "R_repo" } : options.headRepository }] : []);
    if (options.createError) throw new Error("GitHub request failed: unavailable");
    return "https://github.com/test/repo/pull/1\n";
  } };
}

function executable(path: string, content: string) {
  writeFileSync(path, `#!/bin/sh\n${content}\n`);
  chmodSync(path, 0o755);
}

let root: string;
let repo: string;
let bare: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  environment = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "flow-publish-"));
  repo = repository(root, "repo", ["feature/existing"]);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "remote", "add", "origin", "git@github.com:test/repo.git");
  bare = join(root, "bare.git");
  mkdirSync(bare);
  git(bare, "init", "--bare", "--quiet");
  const ssh = join(root, "ssh");
  executable(ssh, `exec git-receive-pack '${bare}'`);
  process.env.GIT_SSH_COMMAND = ssh;
  process.env.GIT_SSH_VARIANT = "ssh";
});
afterEach(() => {
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});

describe("Git Publish", () => {
  it("keeps local changed files and branch when GitHub is unavailable", async () => {
    writeFileSync(join(repo, "a\nfile.txt"), "untracked");
    const status = await gitStatus(repo, async () => { throw new Error("GitHub CLI is missing"); });
    assert.equal(status.branch?.name, "main");
    assert.deepEqual(status.files, [{ path: "a\nfile.txt", status: "??" }]);
    assert.match(status.problem!, /CLI is missing/);
    assert.deepEqual(await gitStatus(root), { repository: false, files: [] });
  });

  it("matches PR repository IDs without requiring repository names", async () => {
    const mock = github({ pr });
    const destination = await target(repo, "feature/existing", mock.run);
    assert.equal(destination.pr?.number, pr.number);
    assert.equal(destination.url, "git@github.com:test/repo.git");
    assert.ok(mock.calls.find((args) => args[0] === "repo")?.at(-1)?.split(",").includes("id"));
  });

  it("accepts renamed repositories with matching IDs", async () => {
    const destination = await target(repo, "feature/existing", github({ pr, headRepository: { id: "R_repo", nameWithOwner: "new-owner/new-name" } }).run);
    assert.equal(destination.pr?.number, pr.number);
  });

  it("refuses different repository IDs even when names match", async () => {
    await assert.rejects(target(repo, "feature/existing", github({ pr, headRepository: { id: "R_other", nameWithOwner: "test/repo" } }).run), /different head repository/);
  });

  it("reports unverifiable PR sources when repository IDs are missing", async () => {
    for (const options of [{ repoId: null }, { repoId: "" }, { headRepository: null }, { headRepository: {} }, { headRepository: { id: "" } }, { repoId: null, headRepository: null }]) {
      await assert.rejects(target(repo, "feature/existing", github({ pr, ...options }).run), /Cannot verify PR source/);
    }
  });

  it("refuses detached and unborn HEAD, forks and ambiguous remotes", async () => {
    await assert.rejects(snapshot(unbornRepository(root, "unborn")), /no commits/);
    git(repo, "checkout", "--detach", "--quiet");
    await assert.rejects(snapshot(repo), /detached/);
    git(repo, "switch", "main");
    await assert.rejects(target(repo, "main", github({ fork: true }).run), /Fork publishing/);
    git(repo, "remote", "add", "other", "git@github.com:other/repo.git");
    await assert.rejects(target(repo, "main", github().run), /exactly one remote/);
    git(repo, "remote", "remove", "other");
    git(repo, "config", "remote.origin.pushurl", "git@github.com:other/repo.git");
    await assert.rejects(target(repo, "main", github().run), /Fetch and push/);
  });

  it("refuses merge conflicts, paused Git operations and submodules", async () => {
    mkdirSync(join(repo, ".git/rebase-merge"));
    await assert.rejects(snapshot(repo), /Finish the current Git operation/);
    rmSync(join(repo, ".git/rebase-merge"), { recursive: true });
    const commit = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${commit},submodule`);
    await assert.rejects(snapshot(repo), /submodules/);
    git(repo, "reset", "--hard", "HEAD");
    writeFileSync(join(repo, "README.md"), "main\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "main change");
    git(repo, "switch", "feature/existing");
    writeFileSync(join(repo, "README.md"), "feature\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feature change");
    assert.throws(() => git(repo, "merge", "main"));
    await assert.rejects(snapshot(repo), /Resolve merge conflicts/);
  });

  it("creates a feature branch, commits staged and untracked files, pushes locally and creates a draft", async () => {
    writeFileSync(join(repo, "README.md"), "staged\n");
    git(repo, "add", "README.md");
    writeFileSync(join(repo, "README.md"), "final reviewed content\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    const reviewed = await snapshot(repo);
    assert.equal(reviewed.files.length, 2);
    const mock = github();
    const destination = await target(repo, reviewed.branch, mock.run);
    const result = await publish(repo, reviewed, destination, input, mock.run);
    assert.equal(result.error, undefined);
    assert.equal(result.pushed, true);
    assert.ok(result.committed);
    assert.equal(git(repo, "branch", "--show-current").trim(), "feature/test");
    assert.equal(git(bare, "show", "feature/test:README.md"), "final reviewed content\n");
    assert.equal(git(bare, "show", "feature/test:new.txt"), "new\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.ok(mock.calls.find((args) => args[1] === "create")?.includes("--draft"));
    assert.equal(git(repo, "log", "-1", "--format=%s").trim(), text.commitMessage);
  });

  it("pushes updates to an existing PR without editing its draft state", async () => {
    git(repo, "switch", "feature/existing");
    const mock = github({ pr });
    const reviewed = await snapshot(repo);
    const destination = await target(repo, reviewed.branch, mock.run);
    const result = await publish(repo, reviewed, destination, { ...input, ready: true }, mock.run);
    assert.equal(result.error, undefined);
    assert.equal(result.url, pr.url);
    assert.equal(result.committed, undefined);
    assert.equal(result.pushed, true);
    assert.ok(mock.calls.every((args) => args[0] !== "pr" || args[1] === "list"));
  });

  it("uses ready only for a new PR", async () => {
    const mock = github();
    const reviewed = await snapshot(repo);
    const result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), { ...input, ready: true }, mock.run);
    assert.equal(result.error, undefined);
    assert.ok(!mock.calls.find((args) => args[1] === "create")?.includes("--draft"));
  });

  it("refuses changed untracked bytes even when the status has not changed", async () => {
    writeFileSync(join(repo, "new.txt"), "first");
    const reviewed = await snapshot(repo);
    writeFileSync(join(repo, "new.txt"), "other");
    const mock = github();
    const result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.match(result.error!, /Reviewed changes have changed/);
    assert.equal(git(repo, "branch", "--show-current").trim(), "main");
    assert.equal(result.pushed, false);
  });

  it("detects staged changes and symlink changes with identical target bytes", async () => {
    writeFileSync(join(repo, "one"), "same");
    writeFileSync(join(repo, "two"), "same");
    symlinkSync("one", join(repo, "link"));
    const first = await snapshot(repo);
    rmSync(join(repo, "link"));
    symlinkSync("two", join(repo, "link"));
    assert.notEqual((await snapshot(repo)).fingerprint, first.fingerprint);
    const next = await snapshot(repo);
    git(repo, "add", "one");
    assert.notEqual((await snapshot(repo)).fingerprint, next.fingerprint);
  });

  it("includes existing branch commits and their files in the review context", async () => {
    git(repo, "switch", "feature/existing");
    writeFileSync(join(repo, "committed.txt"), "committed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Existing branch work");
    const context = await branchChanges(repo, await target(repo, "feature/existing", github().run));
    assert.deepEqual(context.files, [{ path: "committed.txt", status: "A" }]);
    assert.match(context.commits[0]!, /Existing branch work/);
    assert.match(context.input, /\+committed/);
  });

  it("requires a feature branch name and detects changes from checkout hooks", async () => {
    writeFileSync(join(repo, "new.txt"), "new");
    const mock = github();
    const reviewed = await snapshot(repo);
    const destination = await target(repo, reviewed.branch, mock.run);
    const refused = await publish(repo, reviewed, destination, { ...input, branch: "" }, mock.run);
    assert.match(refused.error!, /feature branch name/);
    executable(join(repo, ".git/hooks/post-checkout"), "echo changed > new.txt");
    const changed = await publish(repo, reviewed, destination, input, mock.run);
    assert.equal(changed.branch, "feature/test");
    assert.equal(changed.pushed, false);
    assert.equal(changed.committed, undefined);
    assert.match(changed.error!, /checkout hooks/);
  });

  it("refuses a new feature branch name already used on GitHub", async () => {
    const mock = github({ branchExists: true });
    const reviewed = await snapshot(repo);
    const result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.match(result.error!, /already exists on GitHub/);
    assert.equal(git(repo, "branch", "--show-current").trim(), "main");
    assert.equal(result.pushed, false);
  });

  it("does not push content inserted by commit hooks", async () => {
    git(repo, "switch", "feature/existing");
    writeFileSync(join(repo, "new.txt"), "new");
    executable(join(repo, ".git/hooks/pre-commit"), "echo changed > new.txt\ngit add new.txt");
    const mock = github();
    const reviewed = await snapshot(repo);
    const result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.ok(result.committed);
    assert.equal(result.pushed, false);
    assert.match(result.error!, /hooks changed the committed files/);
  });

  it("refuses extra commit parents introduced by a hook", async () => {
    git(repo, "switch", "-c", "private");
    writeFileSync(join(repo, "private.txt"), "not reviewed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "private work");
    git(repo, "switch", "feature/existing");
    writeFileSync(join(repo, "new.txt"), "reviewed\n");
    executable(join(repo, ".git", "hooks", "post-commit"), 'replacement=$(git commit-tree HEAD^{tree} -p HEAD^ -p refs/heads/private -m replacement)\ngit update-ref HEAD "$replacement"');
    const api = github();
    const result = await publish(repo, await snapshot(repo), await target(repo, "feature/existing", api.run), input, api.run);
    assert.equal(result.pushed, false);
    assert.match(result.error!, /parents changed/);
    assert.equal(git(bare, "for-each-ref"), "");
  });

  it("runs commit hooks and does not bypass a failure", async () => {
    git(repo, "switch", "feature/existing");
    writeFileSync(join(repo, "new.txt"), "new");
    executable(join(repo, ".git/hooks/pre-commit"), "echo 'hook refused' >&2\nexit 1");
    const mock = github();
    const reviewed = await snapshot(repo);
    const result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.match(result.error!, /hook refused/);
    assert.equal(result.committed, undefined);
    assert.equal(result.pushed, false);
    assert.equal(git(repo, "status", "--porcelain").trim(), "A  new.txt");
  });

  it("reports commit success when a push hook refuses, and push success when PR creation fails", async () => {
    git(repo, "switch", "feature/existing");
    writeFileSync(join(repo, "new.txt"), "new");
    const hook = join(repo, ".git/hooks/pre-push");
    executable(hook, "echo 'push refused' >&2\nexit 1");
    const mock = github({ createError: true });
    let reviewed = await snapshot(repo);
    let result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.ok(result.committed);
    assert.equal(result.pushed, false);
    assert.match(result.error!, /push refused/);
    rmSync(hook);
    reviewed = await snapshot(repo);
    result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.equal(result.committed, undefined);
    assert.equal(result.pushed, true);
    assert.match(result.error!, /GitHub request failed/);
  });

  it("does not force a non-fast-forward push", async () => {
    git(repo, "switch", "feature/existing");
    git(repo, "push", bare, "HEAD:refs/heads/feature/existing");
    writeFileSync(join(repo, "ahead"), "ahead");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "ahead");
    git(repo, "push", bare, "HEAD:refs/heads/feature/existing");
    const remoteCommit = git(bare, "rev-parse", "refs/heads/feature/existing").trim();
    git(repo, "reset", "--hard", "HEAD~1");
    writeFileSync(join(repo, "diverged"), "diverged");
    const mock = github();
    const reviewed = await snapshot(repo);
    const result = await publish(repo, reviewed, await target(repo, reviewed.branch, mock.run), input, mock.run);
    assert.ok(result.committed);
    assert.equal(result.pushed, false);
    assert.match(result.error!, /rejected|non-fast-forward/);
    assert.equal(git(bare, "rev-parse", "refs/heads/feature/existing").trim(), remoteCommit);
  });

  it("distinguishes missing gh, authentication failure and request failure", async () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    process.env.PATH = bin;
    await assert.rejects(gh(repo, ["auth", "status"]), /CLI is missing/);
    await assert.rejects(snapshot(repo), /Git is missing/);
    executable(join(bin, "gh"), "echo 'not logged in' >&2\nexit 1");
    await assert.rejects(gh(repo, ["auth", "status"]), /authentication failed/);
    await assert.rejects(gh(repo, ["pr", "list"]), /request failed/);
    executable(join(bin, "gh"), "echo 'HTTP 503 unavailable' >&2\nexit 1");
    await assert.rejects(gh(repo, ["auth", "status"]), /request failed/);
  });
});

describe("Publish Summary Model", () => {
  it("uses a tool-less Backend Session, selected model and no effort", async () => {
    const backend = new FakeBackend();
    backend.autoReply = JSON.stringify(text);
    assert.deepEqual(await summarisePublish({ backend, modelId: "fake-2", text: "diff" }), text);
    assert.equal(backend.latest.toolless, true);
    assert.equal(backend.latest.modelId, "fake-2");
    assert.equal(backend.latest.effort, undefined);
    assert.equal(backend.latest.disposed, true);
    assert.equal(backend.latest.prompts.length, 1);
  });

  it("disposes a Backend Session that finishes starting after the timeout", async () => {
    const backend = new FakeBackend();
    const slow = { name: "slow", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return backend.create(options);
    } };
    await assert.rejects(summarisePublish({ backend: slow, modelId: "fake-1", text: "diff", timeoutMs: 5 }), /timed out/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(backend.latest.disposed, true);
    assert.equal(backend.latest.prompts.length, 0);
  });

  it("rejects invalid output and disposes on timeout", async () => {
    const backend = new FakeBackend();
    backend.autoReply = "not JSON";
    await assert.rejects(summarisePublish({ backend, modelId: "fake-1", text: "diff" }));
    assert.equal(backend.latest.disposed, true);
    backend.autoReply = undefined;
    await assert.rejects(summarisePublish({ backend, modelId: "fake-1", text: "diff", timeoutMs: 10 }), /timed out/);
    assert.equal(backend.latest.disposed, true);
  });
});

describe("Session Host Publish guards", () => {
  function installGh() {
    const bin = join(root, "bin");
    mkdirSync(bin);
    executable(join(bin, "gh"), `case "$1 $2" in\n'auth status') exit 0;;\napi\\ *) echo '[]';;\n'repo view') echo '{"defaultBranchRef":{"name":"main"},"isFork":false}';;\n'pr list') echo '[]';;\n'pr create') echo 'https://github.com/test/repo/pull/1';;\nesac`);
    process.env.PATH = `${bin}:${environment.PATH}`;
  }

  for (const operation of ["settle", "dispose"] as const) {
    it(`refuses publishing while ${operation} stops a Backend Session`, async () => {
      installGh();
      const host = new SessionHost({ retention: 0 });
      const backend = new FakeBackend();
      host.registerBackend(backend);
      const id = await host.create({ scope: repo });
      await host.send(id, "work", "now");
      let release!: () => void;
      const stopped = new Promise<void>((resolve) => { release = resolve; });
      const session = backend.latest;
      const dispose = session.dispose.bind(session);
      session.dispose = async () => { await stopped; await dispose(); };
      const closing = host[operation](id);
      try {
        await assert.rejects(host.preparePublish(id), /stopping/);
        assert.deepEqual(await host.reap(Date.now() + 1_000), []);
      } finally {
        release();
        await closing;
        await host.shutdown();
      }
    });
  }

  it("refuses publish preparation while any Agent Session in the Scope is occupied", async () => {
    const host = new SessionHost();
    const backend = new FakeBackend();
    host.registerBackend(backend);
    const first = await host.create({ scope: repo });
    const second = await host.create({ scope: repo });
    await host.send(first, "work", "now");
    await assert.rejects(host.preparePublish(second), /occupied/);
    await host.shutdown();
  });

  it("lets the user enter text without a Summary Model but refuses confirmation during a turn", async () => {
    installGh();
    writeFileSync(join(repo, "new.txt"), "new");
    const host = new SessionHost();
    const backend = new FakeBackend();
    host.registerBackend(backend);
    const id = await host.create({ scope: repo });
    const review = await host.preparePublish(id);
    assert.match(review.warning!, /No Summary Model/);
    assert.equal(backend.sessions.length, 1);
    await host.send(id, "work", "now");
    await assert.rejects(host.publish(id, { ...input, token: review.token }), /occupied/);
    backend.latest.completeTurn();
    const result = await host.publish(id, { ...input, token: review.token });
    assert.equal(result.error, undefined);
    await host.shutdown();
  });

  it("calls the Summary Model only on opening Publish, blocks send and switch races, and consumes reviews", async () => {
    installGh();
    writeFileSync(join(repo, "new.txt"), "new");
    const host = new SessionHost({ summaryModel: () => ({ backend: "fake", modelId: "fake-2", automatic: false }) });
    const backend = new FakeBackend();
    host.registerBackend(backend);
    const id = await host.create({ scope: repo });
    await host.gitStatus(id);
    assert.equal(backend.sessions.reduce((sum, item) => sum + item.prompts.length, 0), 0);
    const preparing = host.preparePublish(id);
    await assert.rejects(host.send(id, "race", "now"), /Git operation/);
    await assert.rejects(host.switchBranch(id, "feature/existing"), /Git operation/);
    await assert.rejects(host.switchScopeBranch(repo, "feature/existing"), /Git operation/);
    await assert.rejects(host.preparePublish(id), /Git operation/);
    const deadline = Date.now() + 3_000;
    while (backend.latest.prompts.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    backend.latest.say(JSON.stringify(text));
    backend.latest.completeTurn();
    const review = await preparing;
    assert.equal(review.warning, undefined);
    const publishing = host.publish(id, { ...input, token: review.token });
    await assert.rejects(host.send(id, "race", "now"), /Git operation/);
    await assert.rejects(host.switchScopeBranch(repo, "feature/existing"), /Git operation/);
    await assert.rejects(host.publish(id, { ...input, token: review.token }), /Git operation/);
    const result = await publishing;
    assert.equal(result.error, undefined);
    assert.equal(result.pushed, true);
    await assert.rejects(host.publish(id, { ...input, token: review.token }), /expired/);
    assert.equal(backend.sessions.reduce((sum, item) => sum + item.prompts.length, 0), 1);
    await host.shutdown();
  });
});
