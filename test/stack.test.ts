import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { discoverStack, discoverStackGraph, changeStack, cleanStack, parseStack, stackStatus, stackConflictMessage, stackFingerprint } from "../src/daemon/stack.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { gh } from "../src/daemon/publish.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { StackView } from "../src/protocol/stack.ts";

const view: StackView = { trunk: "main", currentBranch: "feature", branches: [{ name: "feature", isCurrent: true, isMerged: false, isQueued: false, needsRebase: false, pr: { number: 12, url: "https://github.com/test/repo/pull/12", state: "OPEN" } }] };
let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "flow-stack-"));
  repo = repository(root, "repo", ["feature"]);
});
afterEach(() => { process.env = env; rmSync(root, { recursive: true, force: true }); });

function installGh() {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "view.json"), JSON.stringify(view));
  const path = join(bin, "gh");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/calls'\ncase "$*" in\n'stack --help') exit 0;;\n'stack view --json') cat '${root}/view.json';;\n*) echo done;;\nesac\n`);
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}:${env.PATH}`;
}
async function hostFixture() {
  installGh();
  const host = new SessionHost();
  const backend = new FakeBackend();
  host.registerBackend(backend);
  const id = await host.create({ scope: repo });
  return { host, backend, id };
}

it("parses the v0.1.1 schema and rejects malformed data", () => {
  assert.deepEqual(parseStack(JSON.stringify(view)), view);
  for (const value of [null, {}, { ...view, branches: [null] }, { ...view, branches: [{}] }, { ...view, branches: [{ ...view.branches[0], pr: { number: "12" } }] }]) assert.throws(() => parseStack(JSON.stringify(value)), /Invalid/);
});

it("probes the actual command and provides installation instructions when unavailable", async () => {
  const calls: string[][] = [];
  const unavailable = await stackStatus(repo, async (_scope, args) => { calls.push(args); throw new Error("missing"); });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.problem!, /gh extension install github\/gh-stack/);
  assert.deepEqual(calls, [["stack", "--help"]]);
  const available = await stackStatus(repo, async (_scope, args) => { calls.push(args); return args[1] === "view" ? JSON.stringify(view) : "help"; });
  assert.equal(available.problem, undefined);
  assert.deepEqual(available.view, view);
  assert.equal(calls.some(args => args[0] === "pr" && args[1] === "view"), false);
});

it("keeps Stack diagnostics and disables editors for non-interactive continuation", async () => {
  installGh();
  writeFileSync(join(root, "bin/gh"), '#!/bin/sh\nprintf "%s %s" "$GIT_EDITOR" "$GIT_SEQUENCE_EDITOR"\necho " conflict details"\nexit 4\n');
  await assert.rejects(gh(repo, ["stack", "rebase", "--continue"]), (error: unknown) => {
    assert.match(String(error), /true true conflict details/);
    assert.doesNotMatch(String(error), /authentication failed/);
    return true;
  });
});

it("uses exact local and remote CLI arguments without --open or stash", async () => {
  const calls: string[][] = [];
  const gh = async (_scope: string, args: string[]) => { calls.push(args); return args[1] === "view" ? JSON.stringify(view) : ""; };
  await changeStack(repo, { action: "add", branches: ["third"] }, gh);
  await changeStack(repo, { action: "checkout", branches: ["feature"] }, gh);
  await changeStack(repo, { action: "rebase" }, gh);
  await changeStack(repo, { action: "submit" }, gh);
  await changeStack(repo, { action: "sync" }, gh);
  assert.deepEqual(calls, [["stack", "add", "third"], ["stack", "--help"], ["stack", "view", "--json"], ["stack", "rebase"], ["stack", "submit", "--auto"], ["stack", "sync"]]);
  await assert.rejects(changeStack(repo, { action: "checkout", branches: ["--force"] }, gh), /Invalid/);
});

it("refuses dirty trees and active Git operations without invoking mutations", async () => {
  writeFileSync(join(repo, "untracked"), "work");
  await assert.rejects(changeStack(repo, { action: "checkout", branches: ["feature"] }, async () => { assert.fail("must not run"); }), /uncommitted/);
  rmSync(join(repo, "untracked"));
  mkdirSync(join(repo, ".git/rebase-merge"));
  await assert.rejects(cleanStack(repo), /Finish or abort/);
});

it("shows conflict files, refuses unresolved continuation, and uses Stack Continue and Abort", async () => {
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "main\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "main");
  git(repo, "switch", "feature");
  writeFileSync(join(repo, "README.md"), "feature\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "feature");
  assert.throws(() => git(repo, "rebase", "main"));
  writeFileSync(join(repo, ".git/gh-stack-rebase-state"), "{}");
  const calls: string[][] = [];
  const gh = async (_scope: string, args: string[]) => { calls.push(args); return args[1] === "view" ? JSON.stringify(view) : ""; };
  assert.deepEqual((await stackStatus(repo, gh)).conflicts, ["README.md"]);
  await assert.rejects(changeStack(repo, { action: "continue" }, gh), /Resolve and stage/);
  writeFileSync(join(repo, "README.md"), "resolved\n"); git(repo, "add", ".");
  await changeStack(repo, { action: "continue" }, gh);
  assert.deepEqual(calls.at(-1), ["stack", "rebase", "--continue"]);
  await changeStack(repo, { action: "abort" }, gh);
  assert.deepEqual(calls.at(-1), ["stack", "rebase", "--abort"]);
});

it("requires a fresh, single-use review and blocks Scope races", async () => {
  const { host, id } = await hostFixture();
  try {
    await assert.rejects(host.changeStack(id, { action: "submit" }), /expired/);
    const preparing = host.prepareStack(id, "submit");
    await assert.rejects(host.send(id, "race", "now"), /Git operation/);
    const review = await preparing;
    assert.deepEqual(review.view, view);
    git(repo, "branch", "new-branch");
    await assert.rejects(host.changeStack(id, { action: "submit", token: review.token }), /reviewed stack changed/);
    const fresh = await host.prepareStack(id, "submit");
    await host.changeStack(id, { action: "submit", token: fresh.token });
    await assert.rejects(host.changeStack(id, { action: "submit", token: fresh.token }), /expired/);
    assert.match(readFileSync(join(root, "calls"), "utf8"), /stack submit --auto/);
    const sync = await host.prepareStack(id, "sync");
    await assert.rejects(host.changeStack(id, { action: "submit", token: sync.token }), /expired/);
  } finally { await host.shutdown(); }
});

it("rejects reviews after PR changes or new uncommitted files", async () => {
  const { host, id } = await hostFixture();
  try {
    const review = await host.prepareStack(id, "submit");
    writeFileSync(join(root, "view.json"), JSON.stringify({ ...view, branches: [{ ...view.branches[0], pr: { number: 13, state: "OPEN" } }] }));
    await assert.rejects(host.changeStack(id, { action: "submit", token: review.token }), /reviewed stack changed/);
    const fresh = await host.prepareStack(id, "sync");
    writeFileSync(join(repo, "new-file"), "new work");
    await assert.rejects(host.changeStack(id, { action: "sync", token: fresh.token }), /uncommitted/);
    assert.doesNotMatch(readFileSync(join(root, "calls"), "utf8"), /stack submit|stack sync/);
  } finally { await host.shutdown(); }
});

it("does not retry a failed Sync and requires confirmation again after Rebase", async () => {
  const { host, id } = await hostFixture();
  try {
    const executable = join(root, "bin/gh");
    writeFileSync(executable, readFileSync(executable, "utf8").replace("*) echo done;;", "'stack sync') echo 'conflict: all branches restored' >&2; exit 1;;\n*) echo done;;"));
    const review = await host.prepareStack(id, "sync");
    await assert.rejects(host.changeStack(id, { action: "sync", token: review.token }), /conflict/);
    await host.changeStack(id, { action: "rebase" });
    await assert.rejects(host.changeStack(id, { action: "sync", token: review.token }), /expired/);
    assert.equal(readFileSync(join(root, "calls"), "utf8").split("\n").filter((line) => line === "stack sync").length, 1);
  } finally { await host.shutdown(); }
});

it("blocks switching when another Agent Session or its background work occupies the Scope", async () => {
  const { host, backend, id } = await hostFixture();
  try {
    const other = await host.create({ scope: repo });
    await host.send(other, "work", "now");
    await assert.rejects(host.changeStack(id, { action: "checkout", branches: ["feature"] }), /occupied/);
    const subagent = backend.latest.beginSubagent("worker", "work");
    backend.latest.completeTurn();
    await assert.rejects(host.changeStack(id, { action: "checkout", branches: ["feature"] }), /Subagent or Background Call/);
    subagent.finish();
    const call = backend.latest.backgroundCall();
    await assert.rejects(host.changeStack(id, { action: "checkout", branches: ["feature"] }), /Subagent or Background Call/);
    call.settle();
  } finally { await host.shutdown(); }
});

it("sends conflict assistance through the current Agent Session without permitting remote actions", async () => {
  const { host, backend, id } = await hostFixture();
  try {
    await assert.rejects(host.assistStack(id), /No Stack rebase/);
    writeFileSync(join(repo, ".git/gh-stack-rebase-state"), "{}");
    await host.assistStack(id);
    assert.equal(backend.latest.prompts.length, 1);
    assert.match(JSON.stringify(backend.latest.prompts[0]), /gh stack rebase --continue/);
    assert.match(stackConflictMessage, /only after.*empty/);
    assert.match(stackConflictMessage, /Do not push, publish, submit, sync, merge/);
    assert.doesNotMatch(readFileSync(join(root, "calls"), "utf8"), /stack rebase --continue|stack sync|stack submit/);
  } finally { await host.shutdown(); }
});


it("switches numeric local stack branches without passing a PR number to gh", async () => {
  git(repo, "branch", "123");
  const numeric = { ...view, branches: [...view.branches, { ...view.branches[0], name: "123", isCurrent: false }] };
  const mock = async (_scope: string, args: string[]) => {
    assert.ok(args[1] === "--help" || args[1] === "view");
    return JSON.stringify(numeric);
  };
  await changeStack(repo, { action: "checkout", branches: ["123"] }, mock);
  assert.equal(git(repo, "branch", "--show-current").trim(), "123");
  await assert.rejects(changeStack(repo, { action: "checkout", branches: ["main"] }, mock), /current local stack/);
});

it("refuses Sync when remote membership changes after the review", async () => {
  const { host, id } = await hostFixture();
  try {
    writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ id: "42", trunk: { branch: "main" }, branches: [{ branch: "feature", pullRequest: { number: 12 } }] }] }));
    const remote = { id: 42, pull_requests: [{ number: 12, head: { ref: "feature" } }] };
    writeFileSync(join(root, "remote.json"), JSON.stringify(remote));
    const executable = join(root, "bin/gh");
    writeFileSync(executable, readFileSync(executable, "utf8").replace("*) echo done;;", `api*) cat '${root}/remote.json';;\n*) echo done;;`));
    const review = await host.prepareStack(id, "sync");
    remote.pull_requests.push({ number: 13, head: { ref: "unreviewed" } });
    writeFileSync(join(root, "remote.json"), JSON.stringify(remote));
    await assert.rejects(host.changeStack(id, { action: "sync", token: review.token }), /membership differs/);
    await assert.rejects(host.prepareStack(id, "sync"), /membership differs/);
    assert.doesNotMatch(readFileSync(join(root, "calls"), "utf8"), /stack sync/);
  } finally { await host.shutdown(); }
});

it("refuses Sync from trunk before remote membership can be skipped", async () => {
  const { host, id } = await hostFixture();
  try {
    writeFileSync(join(root, "view.json"), JSON.stringify({ ...view, currentBranch: "main" }));
    await assert.rejects(host.prepareStack(id, "sync"), /Switch to a branch in the stack/);
    assert.doesNotMatch(readFileSync(join(root, "calls"), "utf8"), /stack sync/);
  } finally { await host.shutdown(); }
});

it("checks remote membership at review and confirmation, refusing additions and errors", async () => {
  writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ id: "42", trunk: { branch: "main" }, branches: [{ branch: "feature", pullRequest: { number: 12 } }] }] }));
  const remote = { id: 42, pull_requests: [{ number: 12, head: { ref: "feature" } }] };
  const mock = async () => JSON.stringify(remote);
  const reviewed = await stackFingerprint(repo, view, true, mock);
  assert.equal(await stackFingerprint(repo, view, true, mock), reviewed);
  remote.pull_requests.push({ number: 13, head: { ref: "unreviewed" } });
  await assert.rejects(stackFingerprint(repo, view, true, mock), /Remote stack membership differs/);
  remote.pull_requests = [];
  await assert.rejects(stackFingerprint(repo, view, true, mock), /Remote stack membership differs/);
  await assert.rejects(stackFingerprint(repo, view, true, async () => { throw new Error("API unavailable"); }), /API unavailable/);
  await assert.rejects(stackFingerprint(repo, view, true, async () => JSON.stringify({ id: 42, pull_requests: [] })), /membership differs/);
});

function chain() {
  git(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
  git(repo, "switch", "feature");
  git(repo, "commit", "--allow-empty", "-m", "feature");
  git(repo, "switch", "-c", "second");
  git(repo, "commit", "--allow-empty", "-m", "second");
}

function pr(number: number, branch: string, base: string, merged = false) {
  return { number, state: merged ? "closed" : "open", merged_at: merged ? "2026-01-01" : null,
    head: { ref: branch, repo: { node_id: "repo-id" } }, base: { ref: base, repo: { node_id: "repo-id" } } };
}
function githubFixture(prs = [pr(23, "feature", "main", true), pr(22, "second", "feature")]) {
  const calls: string[][] = [];
  const github = async (scope: string, args: string[]) => {
    assert.equal(scope, repo);
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify({ id: "repo-id", defaultBranchRef: { name: "main" }, isFork: false });
    if (args[0] === "api") {
      assert.equal(args[0], "api");
      assert.ok(args.includes("--jq"));
      assert.equal(args.at(-1), "repos/test/repo/pulls?state=all&per_page=100");
      return JSON.stringify([prs]);
    }
    calls.push(args);
    return "done";
  };
  return { prs, github, calls };
}

it("retains candidate PR titles and URLs in branch order", async () => {
  chain();
  const prs = [pr(23, "feature", "main", true), pr(22, "second", "feature")].map(pr => ({ ...pr, title: `Title ${pr.number}`, html_url: `https://github.com/test/repo/pull/${pr.number}` }));
  const { github } = githubFixture(prs);
  assert.deepEqual((await discoverStack(repo, github))!.pullRequests.map(pr => [pr.title, pr.url]), prs.map(pr => [pr.title, pr.html_url]));
});

it("keeps the stack visible when PR title loading fails", async () => {
  const state = await stackStatus(repo, async (_scope, args) => {
    if (args[0] === "pr") throw new Error("GitHub unavailable");
    return args[1] === "view" ? JSON.stringify(view) : "";
  });
  assert.deepEqual(state.view, view);
  assert.equal(state.warnings?.some(warning => warning.includes("PR #")) ?? false, false);
});

it("registers a PR-linked chain and retains merged status without commit ancestry", async () => {
  chain();
  git(repo, "branch", "-f", "feature", "second");
  const { github, calls } = githubFixture();
  const candidate = (await discoverStack(repo, github))!;
  assert.deepEqual(candidate.branches, ["feature", "second"]);
  assert.deepEqual(candidate.pullRequests, [{ branch: "feature", number: 23, state: "MERGED" }, { branch: "second", number: 22, state: "OPEN" }]);
  await changeStack(repo, { action: "init", ...candidate }, github);
  assert.deepEqual(calls, [["stack", "init", "--base", "main", "feature", "second"]]);
  git(repo, "switch", "main");
  assert.equal(await discoverStack(repo, github), undefined);
});

for (const failure of ["siblings", "no PR", "one PR", "missing branch", "forked chain", "cycle", "foreign repository", "tracked", "missing trunk", "detached", "multiple remotes", "unavailable"]) it(`does not infer a stack: ${failure}`, async () => {
  chain();
  const fixture = githubFixture();
  if (failure === "siblings") fixture.prs[1]!.base.ref = "main";
  if (failure === "no PR") fixture.prs.length = 0;
  if (failure === "one PR") fixture.prs.shift();
  if (failure === "missing branch") git(repo, "branch", "-D", "feature");
  if (failure === "forked chain") fixture.prs.push(pr(24, "missing", "feature"));
  if (failure === "cycle") fixture.prs[0]!.base.ref = "second";
  if (failure === "foreign repository") fixture.prs[0]!.head.repo.node_id = "fork";
  if (failure === "tracked") writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "feature" }] }] }));
  if (failure === "missing trunk") git(repo, "branch", "-D", "main");
  if (failure === "detached") git(repo, "switch", "--detach");
  if (failure === "multiple remotes") git(repo, "remote", "add", "other", "https://github.com/other/repo.git");
  if (failure === "unavailable") fixture.github = async () => { throw new Error("offline"); };
  assert.equal(await discoverStack(repo, fixture.github), undefined);
  assert.deepEqual(fixture.calls, []);
});

for (const change of ["deleted", "changed", "missing", "metadata", "base", "status", "head", "number"]) it(`refuses init after ${change} changes without creating anything`, async () => {
  chain();
  const { github, prs, calls } = githubFixture();
  const candidate = (await discoverStack(repo, github))!;
  if (change === "deleted") git(repo, "branch", "-D", "feature");
  if (change === "changed") git(repo, "commit", "--allow-empty", "-m", "later");
  if (change === "missing") candidate.branches = ["missing", "second"];
  if (change === "metadata") writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "feature" }] }] }));
  if (change === "base") prs[1]!.base.ref = "main";
  if (change === "status") prs[1]!.state = "closed";
  if (change === "head") prs[1]!.head.ref = "renamed";
  if (change === "number") prs[1]!.number = 99;
  const before = git(repo, "show-ref");
  await assert.rejects(changeStack(repo, { action: "init", ...candidate }, github), /chain changed or is not eligible/);
  assert.equal(git(repo, "show-ref"), before);
  assert.deepEqual(calls, []);
});

it("reports an expected no-stack state without the gh error", async () => {
  const status = await stackStatus(repo, async (_scope, args) => {
    if (args[1] === "view") throw new Error("GitHub request failed: current branch main not part of stack");
    return "";
  });
  assert.equal(status.problem, undefined);
  assert.equal(status.view, undefined);
  assert.equal(status.candidate, undefined);
});

it("refuses a names-only init even when those branches exist", async () => {
  chain();
  const { github, calls } = githubFixture();
  await assert.rejects(changeStack(repo, { action: "init", branches: ["feature", "second"] }, github), /chain changed or is not eligible/);
  assert.deepEqual(calls, []);
});

it("uses GitHub's default branch, not stale remote HEAD, and ignores unrelated PRs", async () => {
  chain();
  git(repo, "branch", "-m", "main", "develop");
  git(repo, "update-ref", "refs/remotes/origin/main", "feature");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const fixture = githubFixture();
  fixture.prs[0]!.base.ref = "develop";
  fixture.prs.push(pr(24, "unrelated", "develop"));
  const github = async (scope: string, args: string[]) => args[0] === "repo"
    ? JSON.stringify({ id: "repo-id", defaultBranchRef: { name: "develop" }, isFork: false })
    : fixture.github(scope, args);
  assert.equal((await discoverStack(repo, github))?.trunk, "develop");
  git(repo, "switch", "develop");
  assert.equal(await discoverStack(repo, github), undefined);
});

it("loads titles for tracked merged members without rediscovering the chain", async () => {
  const tracked = { ...view, branches: [{ ...view.branches[0]!, isMerged: true, pr: { number: 23, state: "MERGED" } }] };
  const state = await stackStatus(repo, async (_scope, args) => {
    assert.notEqual(args[0], "pr");
    assert.equal(args[0], "stack");
    return args[1] === "view" ? JSON.stringify(tracked) : "";
  });
  assert.equal(state.problem, undefined);
  assert.deepEqual(state.view, tracked);
  assert.equal(state.candidate, undefined);
});

function discoveryGithub(pulls: ReturnType<typeof pr>[] = [], native: any[] = [], options: { extension?: boolean; nativeFailure?: Error } = {}) {
  const calls: string[][] = [];
  const github = async (_scope: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "stack") {
      if (options.extension === false) throw new Error("extension missing");
      if (args[1] === "view") throw new Error("current branch second is not part of a stack");
      return "";
    }
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify({ id: "repo-id", defaultBranchRef: { name: "main" }, isFork: false });
    if (args[0] === "api" && args.at(-1)?.includes("/stacks?")) {
      if (options.nativeFailure) throw options.nativeFailure;
      return JSON.stringify([native]);
    }
    if (args[0] === "api" && args.at(-1)?.includes("/pulls?")) return JSON.stringify([pulls]);
    throw new Error(`Unexpected GitHub call: ${args.join(" ")}`);
  };
  return { github, calls };
}

it("discovers a native stack without gh-stack, local trunk, or every local member", async () => {
  chain();
  git(repo, "branch", "-D", "main");
  const pulls = [
    { ...pr(1, "feature", "main", true), title: "Foundation", html_url: "https://github.com/test/repo/pull/1" },
    { ...pr(2, "second", "feature"), title: "Current", html_url: "https://github.com/test/repo/pull/2" },
    { ...pr(3, "remote-top", "second"), title: "Remote top", html_url: "https://github.com/test/repo/pull/3" },
  ];
  const native = [{ id: 44, open: true, base: { ref: "main" }, pull_requests: pulls.map(item => ({ number: item.number, state: item.state, merged_at: item.merged_at, head: { ref: item.head.ref } })) }];
  const fixture = discoveryGithub(pulls, native, { extension: false });
  const status = await stackStatus(repo, fixture.github);
  assert.equal(status.available, false);
  assert.equal(status.problemKind, "action");
  assert.equal(status.graph?.trunk, "main");
  assert.deepEqual(status.graph?.branches.map(branch => [branch.name, branch.parent, branch.availability, branch.pr?.state]), [
    ["feature", "main", "local", "MERGED"],
    ["second", "feature", "local", "OPEN"],
    ["remote-top", "second", "remote", "OPEN"],
  ]);
  assert.ok(fixture.calls.some(args => args.at(-1)?.includes("/stacks?")));
});

it("loads each remote discovery resource once for status", async () => {
  chain();
  const fixture = discoveryGithub([pr(1, "feature", "main"), pr(2, "second", "feature")]);
  const status = await stackStatus(repo, fixture.github);
  assert.ok(status.graph);
  assert.ok(status.candidate);
  assert.equal(fixture.calls.filter(args => args[0] === "repo").length, 1);
  assert.equal(fixture.calls.filter(args => args.at(-1)?.includes("/pulls?")).length, 1);
  assert.equal(fixture.calls.filter(args => args.at(-1)?.includes("/stacks?")).length, 1);
});

it("builds a PR branching graph, keeps merged ancestors, and ignores history and unrelated roots", async () => {
  chain();
  const pulls = [
    pr(10, "feature", "main", true),
    pr(11, "second", "feature"),
    pr(12, "remote-sibling", "feature"),
    pr(9, "second", "old-base", true),
    { ...pr(8, "second", "abandoned"), state: "closed" },
    pr(20, "unrelated", "main"),
  ];
  const fixture = discoveryGithub(pulls, [], { nativeFailure: new Error("native endpoint offline") });
  const result = await discoverStackGraph(repo, fixture.github);
  assert.match(result.warnings.join("\n"), /native endpoint offline/);
  assert.deepEqual(result.graph?.branches.map(branch => [branch.name, branch.parent, branch.pr?.number]), [
    ["feature", "main", 10],
    ["remote-sibling", "feature", 12],
    ["second", "feature", 11],
  ]);
  assert.equal(result.graph?.branches.find(branch => branch.name === "feature")?.pr?.state, "MERGED");
  assert.equal(result.graph?.branches.some(branch => branch.name === "unrelated"), false);
});

it("infers only strict local ancestry and includes siblings without joining divergent roots", async () => {
  chain();
  git(repo, "switch", "feature");
  git(repo, "switch", "-c", "sibling");
  git(repo, "commit", "--allow-empty", "-m", "sibling");
  git(repo, "switch", "main");
  git(repo, "switch", "-c", "divergent");
  git(repo, "commit", "--allow-empty", "-m", "divergent");
  git(repo, "switch", "second");
  const result = await discoverStackGraph(repo, discoveryGithub().github);
  assert.deepEqual(result.graph?.branches.map(branch => [branch.name, branch.parent, branch.relation]), [
    ["feature", "main", "ancestry"],
    ["second", "feature", "ancestry"],
    ["sibling", "feature", "ancestry"],
  ]);
  assert.equal(result.graph?.branches.some(branch => branch.name === "divergent"), false);
});

it("omits ambiguous equal-tip ancestry rather than guessing", async () => {
  chain();
  git(repo, "branch", "same-feature", "feature");
  const result = await discoverStackGraph(repo, discoveryGithub().github);
  assert.equal(result.graph, undefined);
  assert.match(result.warnings.join("\n"), /equally near parents for second/);
});

it("reports explicit conflicts and PR cycles while preserving safe partial data", async () => {
  chain();
  writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "feature" }, { branch: "second" }] }] }));
  const native = [{ id: 1, open: true, base: { ref: "main" }, pull_requests: [{ number: 2, state: "open", merged_at: null, head: { ref: "second" } }] }];
  const conflict = await discoverStackGraph(repo, discoveryGithub([], native).github);
  assert.match(conflict.warnings.join("\n"), /Conflicting explicit stack parents for second/);
  assert.deepEqual(conflict.graph?.branches.map(branch => [branch.name, branch.parent]), [["second", undefined]]);

  rmSync(join(repo, ".git/gh-stack"));
  const cycle = await discoverStackGraph(repo, discoveryGithub([pr(1, "feature", "second"), pr(2, "second", "feature")]).github);
  assert.equal(cycle.graph, undefined);
  assert.match(cycle.warnings.join("\n"), /cycle involving feature, second/);
});

it("reports an unknown trunk for meaningful local history without guessing main", async () => {
  git(repo, "switch", "feature");
  git(repo, "commit", "--allow-empty", "-m", "feature");
  git(repo, "switch", "-c", "second");
  git(repo, "commit", "--allow-empty", "-m", "second");
  let called = false;
  const before = git(repo, "show-ref");
  const result = await discoverStackGraph(repo, async () => { called = true; throw new Error("must not call GitHub without a remote"); });
  assert.equal(called, false);
  assert.equal(result.graph, undefined);
  assert.match(result.warnings.join("\n"), /trunk branch is unknown/);
  assert.equal(git(repo, "show-ref"), before);
});

it("lets a current open PR replace historical PRs for candidate registration", async () => {
  chain();
  const fixture = githubFixture([pr(1, "feature", "main", true), pr(2, "feature", "wrong-old-base", true), pr(3, "feature", "main"), pr(4, "second", "feature")]);
  const candidate = await discoverStack(repo, fixture.github);
  assert.deepEqual(candidate?.pullRequests.map(item => item.number), [3, 4]);
});
