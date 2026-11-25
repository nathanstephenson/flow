import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository, unbornRepository } from "./git-fixture.ts";
import { changeStack, cleanStack, parseStack, stackStatus, stackTitles, stackConflictMessage, stackFingerprint } from "../src/daemon/stack.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { gh } from "../src/daemon/github.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { stackMergeBlock, type StackStatus, type StackView } from "../src/protocol/stack.ts";

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

it("parses the gh stack view JSON and rejects malformed data", () => {
  assert.deepEqual(parseStack(JSON.stringify(view)), view);
  for (const value of [null, {}, { ...view, branches: [null] }, { ...view, branches: [{}] }, { ...view, branches: [{ ...view.branches[0], pr: { number: "12" } }] }]) assert.throws(() => parseStack(JSON.stringify(value)), /Invalid/);
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
    mkdirSync(join(repo, ".git/rebase-merge"));
    await host.assistStack(id);
    assert.equal(backend.latest.prompts.length, 1);
    assert.match(JSON.stringify(backend.latest.prompts[0]), /gh stack rebase --continue/);
    assert.match(stackConflictMessage, /only after.*empty/);
    assert.match(stackConflictMessage, /Do not push, submit, sync, merge/);
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
  git(repo, "switch", "feature");
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

function notInStack(branch: string, calls: string[][] = []) {
  return async (_scope: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "view") throw new Error(`GitHub request failed: ✗ current branch "${branch}" is not part of a stack`);
    return "";
  };
}
function defaultBranch(name = "main") {
  git(repo, "remote", "add", "origin", join(root, "remote.git"));
  git(repo, "update-ref", `refs/remotes/origin/${name}`, name);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${name}`);
}
function registered(trunk: string, branches: string[]) {
  writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: trunk }, branches: branches.map(branch => ({ branch })) }] }));
}

it("hides Stack and asks nothing more when gh stack is missing", async () => {
  const calls: string[][] = [];
  const status = await stackStatus(repo, async (_scope, args) => { calls.push(args); throw new Error('unknown command "stack" for "gh"'); });
  assert.deepEqual(status, { available: false, conflicts: [], rebasing: false });
  assert.deepEqual(calls, [["stack", "--help"]]);
});

it("merges the whole stack with the chosen method and refuses an invalid method", async () => {
  const calls: string[][] = [];
  const gh = async (_scope: string, args: string[]) => { calls.push(args); return args[1] === "view" ? JSON.stringify(view) : ""; };
  await changeStack(repo, { action: "merge", method: "SQUASH" }, gh);
  assert.deepEqual(calls.at(-1), ["stack", "merge", "--yes", "--squash"]);
  for (const method of [undefined, "FAST" as never]) await assert.rejects(changeStack(repo, { action: "merge", ...(method ? { method } : {}) }, gh), /Invalid merge method/);
});

it("refuses to merge a stack with a branch that has no open, ready pull request", async () => {
  const branch = view.branches[0]!;
  const blocked = (changes: Partial<typeof branch>) => ({ ...view, branches: [{ ...branch, ...changes }] });
  assert.equal(stackMergeBlock(view), undefined);
  assert.equal(stackMergeBlock(blocked({ isMerged: true, pr: { ...branch.pr!, state: "MERGED" } })), "All pull requests of this stack are merged.");
  assert.equal(stackMergeBlock({ ...view, branches: [{ ...branch, isMerged: true, pr: { ...branch.pr!, state: "MERGED" } }, branch] }), undefined);
  const { pr: _, ...withoutPr } = branch;
  assert.equal(stackMergeBlock({ ...view, branches: [withoutPr] }), "feature has no pull request. Submit the stack first.");
  assert.equal(stackMergeBlock(blocked({ pr: { ...branch.pr!, state: "CLOSED" } })), "#12 is closed.");
  assert.equal(stackMergeBlock(blocked({ pr: { ...branch.pr!, isDraft: true } })), "#12 is a draft. Mark it ready for review first.");
  const calls: string[][] = [];
  const gh = async (_scope: string, args: string[]) => { calls.push(args); return args[1] === "view" ? JSON.stringify(blocked({ pr: { ...branch.pr!, isDraft: true } })) : ""; };
  await assert.rejects(changeStack(repo, { action: "merge", method: "MERGE" }, gh), /draft/);
  assert.ok(!calls.some(args => args[1] === "merge"));
});

it("offers only the repository's merge methods and refuses another method at confirmation", async () => {
  const { host, id } = await hostFixture();
  git(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
  writeFileSync(join(root, "bin/gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/calls'\ncase "$*" in\n'stack --help') exit 0;;\n'stack view --json') cat '${root}/view.json';;\nauth*) exit 0;;\nrepo*) echo '{"id":"R","defaultBranchRef":{"name":"main"},"isFork":false}';;\n*mergeCommitAllowed*) echo '{"data":{"repository":{"isArchived":false,"viewerPermission":"WRITE","mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false}}}';;\n*) echo done;;\nesac\n`);
  try {
    const review = await host.prepareStack(id, "merge");
    assert.deepEqual(review.mergeMethods, ["SQUASH"]);
    await assert.rejects(host.changeStack(id, { action: "merge", token: review.token, method: "MERGE" }), /does not permit/);
    const fresh = await host.prepareStack(id, "merge");
    await host.changeStack(id, { action: "merge", token: fresh.token, method: "SQUASH" });
    assert.match(readFileSync(join(root, "calls"), "utf8"), /stack merge --yes --squash/);
  } finally { await host.shutdown(); }
});

it("shows how far each stack branch is ahead of and behind its upstream", async () => {
  git(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
  git(repo, "branch", "second");
  git(repo, "switch", "--quiet", "feature");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "remote");
  git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD");
  git(repo, "reset", "--quiet", "--hard", "main");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "local one");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "local two");
  git(repo, "branch", "--quiet", "--set-upstream-to=origin/feature");
  const stack: StackView = { ...view, branches: [view.branches[0]!, { ...view.branches[0]!, name: "second", isCurrent: false }] };
  const status = await stackStatus(repo, async (_scope, args) => args[1] === "view" ? JSON.stringify(stack) : "");
  assert.deepEqual(status.view?.branches.map(branch => [branch.name, branch.ahead, branch.behind]), [["feature", 2, 1], ["second", undefined, undefined]]);
});

it("reads the registered stack of the current branch", async () => {
  git(repo, "switch", "feature");
  const calls: string[][] = [];
  const status = await stackStatus(repo, async (_scope, args) => { calls.push(args); return args[1] === "view" ? JSON.stringify(view) : "help"; });
  assert.deepEqual(status, { available: true, conflicts: [], rebasing: false, view });
  assert.deepEqual(calls, [["stack", "--help"], ["stack", "view", "--json"]]);
});

it("offers Create stack with the default trunk and the local branches on a branch that is not in a stack", async () => {
  git(repo, "branch", "second");
  git(repo, "branch", "stacked");
  defaultBranch();
  registered("main", ["stacked"]);
  git(repo, "switch", "feature");
  const status = await stackStatus(repo, notInStack("feature"));
  assert.equal(status.view, undefined);
  assert.equal(status.create?.current, "feature");
  assert.equal(status.create?.trunk, "main");
  assert.deepEqual([...status.create!.branches].sort(), ["feature", "main", "second", "stacked"]);
  assert.deepEqual([...status.create!.unstacked].sort(), ["feature", "main", "second"]);
});

it("reads the stack metadata of a linked worktree from the common Git directory", async () => {
  git(repo, "branch", "stacked");
  registered("main", ["stacked"]);
  const worktree = join(root, "worktree");
  git(repo, "worktree", "add", "--quiet", worktree, "feature");
  const status = await stackStatus(worktree, notInStack("feature"));
  assert.deepEqual([...status.create!.unstacked].sort(), ["feature", "main"]);
});

it("offers the Stack rebase only in the worktree where it stopped", async () => {
  const worktree = join(root, "worktree");
  git(repo, "worktree", "add", "--quiet", worktree, "feature");
  writeFileSync(join(repo, ".git/gh-stack-rebase-state"), "{}");
  mkdirSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge").trim());
  assert.equal((await stackStatus(worktree, notInStack("feature"))).rebasing, true);
  const calls: string[][] = [];
  const main = await stackStatus(repo, notInStack("main", calls));
  assert.equal(main.rebasing, false);
  assert.equal(main.notice, "A stack rebase is in progress in another worktree.");
  assert.deepEqual(calls, [["stack", "--help"]]);
  for (const action of ["abort", "continue"] as const) await assert.rejects(changeStack(repo, { action }, notInStack("main", calls)), /another worktree/);
  await assert.rejects(changeStack(repo, { action: "rebase" }, notInStack("main", calls)), /another worktree/);
  await assert.rejects(cleanStack(worktree), /Finish or abort/);
  assert.equal(calls.some(args => ["abort", "continue", "rebase"].some(action => args.includes(action) || args.includes(`--${action}`))), false);
});

it("shows a one-line notice on a branch with no commits", async () => {
  const unborn = unbornRepository(root, "unborn");
  const calls: string[][] = [];
  const status = await stackStatus(unborn, notInStack("main", calls));
  assert.equal(status.create, undefined);
  assert.match(status.notice!, /no commits/);
  assert.deepEqual(calls, [["stack", "--help"]]);
});

it("shows a one-line notice on the trunk and on a detached HEAD", async () => {
  defaultBranch();
  const onTrunk = await stackStatus(repo, notInStack("main"));
  assert.equal(onTrunk.create, undefined);
  assert.match(onTrunk.notice!, /trunk/);
  registered("feature", ["other"]);
  git(repo, "switch", "feature");
  const trunkCalls: string[][] = [];
  assert.match((await stackStatus(repo, notInStack("feature", trunkCalls))).notice!, /trunk/);
  writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "feature" }, branches: [{ branch: "one" }] }, { trunk: { branch: "feature" }, branches: [{ branch: "two" }] }] }));
  assert.match((await stackStatus(repo, notInStack("feature", trunkCalls))).notice!, /trunk/);
  assert.deepEqual(trunkCalls, [["stack", "--help"], ["stack", "--help"]]);
  git(repo, "switch", "--detach");
  const calls: string[][] = [];
  const detached = await stackStatus(repo, notInStack("HEAD", calls));
  assert.equal(detached.create, undefined);
  assert.match(detached.notice!, /detached/);
  assert.deepEqual(calls, [["stack", "--help"]]);
});

it("reports a gh stack view failure that is not the no-stack answer", async () => {
  await assert.rejects(stackStatus(repo, async (_scope, args) => { if (args[1] === "view") throw new Error("GitHub request failed: HTTP 502"); return ""; }), /HTTP 502/);
});

it("reads Pull Request titles with one query and not again when nothing changed for 5 minutes", async () => {
  git(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
  const queries: string[] = [];
  const github = async (_scope: string, args: string[]) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify({ id: "R", defaultBranchRef: { name: "main" }, isFork: false });
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    assert.ok(args.includes("owner=test") && args.includes("name=repo"));
    queries.push(args.find(arg => arg.startsWith("query="))!);
    return JSON.stringify({ data: { repository: { pr12: { title: "Twelve", isDraft: true }, pr13: { title: "Thirteen", isDraft: false } } } });
  };
  const stack: StackView = { ...view, branches: [view.branches[0]!, { ...view.branches[0]!, name: "second", isCurrent: false, pr: { number: 13, url: "https://github.com/test/repo/pull/13", state: "OPEN" } }, { name: "unpublished", isCurrent: false, isMerged: false, isQueued: false, needsRebase: false }] };
  const first = structuredClone(stack);
  assert.equal(await stackTitles(repo, first, github), true);
  assert.deepEqual(first.branches.map(branch => branch.pr?.title), ["Twelve", "Thirteen", undefined]);
  assert.deepEqual(first.branches.map(branch => branch.pr?.isDraft), [true, false, undefined]);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /pr12:pullRequest\(number:12\)\{title isDraft\}.*pr13:pullRequest\(number:13\)\{title isDraft\}/);
  const again = structuredClone(stack);
  await stackTitles(repo, again, github);
  assert.equal(again.branches[1]!.pr?.title, "Thirteen");
  assert.equal(queries.length, 1);
  const changed = structuredClone(stack);
  changed.branches[1]!.pr!.state = "MERGED";
  await stackTitles(repo, changed, github);
  assert.equal(queries.length, 2);
  const now = Date.now;
  try {
    Date.now = () => now() + 5 * 60_000 + 1;
    await stackTitles(repo, structuredClone(changed), github);
    assert.equal(queries.length, 3);
  } finally { Date.now = now; }
});

it("keeps the stack without titles when the title query fails, and does not ask again for 5 minutes", async () => {
  git(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
  let queries = 0;
  const github = async (_scope: string, args: string[]) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify({ id: "R", defaultBranchRef: { name: "main" }, isFork: false });
    queries++;
    throw new Error("GitHub request failed: HTTP 502");
  };
  const stack = structuredClone(view);
  assert.equal(await stackTitles(repo, stack, github), false);
  assert.deepEqual(stack, view);
  assert.equal(await stackTitles(repo, structuredClone(view), github), false);
  assert.equal(queries, 1);
});

it("uses the titles that resolve when one pull request is not found", async () => {
  git(repo, "remote", "add", "origin", "https://github.com/test/repo.git");
  const queries: string[] = [];
  const github = async (_scope: string, args: string[]) => {
    if (args[0] === "auth") return "";
    if (args[0] === "repo") return JSON.stringify({ id: "R", defaultBranchRef: { name: "main" }, isFork: false });
    const query = args.find(arg => arg.startsWith("query="))!;
    queries.push(query);
    if (query.includes("pr13:")) throw new Error("GitHub request failed: gh: Could not resolve to a PullRequest with the number of 13.");
    return JSON.stringify({ data: { repository: { pr12: { title: "Twelve" } } } });
  };
  const stack: StackView = { ...view, branches: [view.branches[0]!, { ...view.branches[0]!, name: "second", isCurrent: false, pr: { number: 13, url: "https://github.com/test/repo/pull/13", state: "OPEN" } }] };
  const read = structuredClone(stack);
  assert.equal(await stackTitles(repo, read, github), false);
  assert.deepEqual(read.branches.map(branch => branch.pr?.title), ["Twelve", undefined]);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1]!, /pr13:/);
  const again = structuredClone(stack);
  assert.equal(await stackTitles(repo, again, github), false);
  assert.equal(again.branches[0]!.pr?.title, "Twelve");
  assert.equal(queries.length, 2);
});

it("registers the chosen trunk and branches in order with gh stack init", async () => {
  git(repo, "branch", "second");
  const calls: string[][] = [];
  await changeStack(repo, { action: "init", trunk: "main", branches: ["second", "feature"] }, async (_scope, args) => { calls.push(args); return ""; });
  assert.deepEqual(calls, [["stack", "--help"], ["stack", "init", "--base", "main", "second", "feature"]]);
});

it("refuses init when gh stack is missing", async () => {
  const calls: string[][] = [];
  await assert.rejects(changeStack(repo, { action: "init", trunk: "main", branches: ["feature"] }, async (_scope, args) => { calls.push(args); throw new Error("unknown command"); }), /gh extension install github\/gh-stack/);
  assert.deepEqual(calls, [["stack", "--help"]]);
});

for (const [name, input, refusal] of [
  ["a missing trunk", { trunk: "develop", branches: ["feature"] }, /develop is not a local branch/],
  ["an option as the trunk", { trunk: "--force", branches: ["feature"] }, /--force is not a local branch/],
  ["no branches", { trunk: "main", branches: [] }, /Enter a branch name/],
  ["a missing branch", { trunk: "main", branches: ["missing"] }, /missing is not a local branch/],
  ["an option as a branch", { trunk: "main", branches: ["--force"] }, /Invalid branch name/],
  ["the trunk as a branch", { trunk: "main", branches: ["feature", "main"] }, /main is the trunk/],
  ["a duplicate branch", { trunk: "main", branches: ["feature", "feature"] }, /feature is listed twice/],
  ["a branch in a registered stack", { trunk: "main", branches: ["feature", "stacked"] }, /stacked is already in a stack/],
] as const) it(`refuses init with ${name}`, async () => {
  git(repo, "branch", "stacked");
  registered("main", ["stacked"]);
  const calls: string[][] = [];
  await assert.rejects(changeStack(repo, { action: "init", ...input, branches: [...input.branches] }, async (_scope, args) => { calls.push(args); return ""; }), refusal);
  assert.equal(calls.some(args => args[1] === "init"), false);
});

function holdGh(command: string) {
  const executable = join(root, "bin/gh");
  writeFileSync(executable, readFileSync(executable, "utf8").replace(`case "$*" in`, `[ "$*" = '${command}' ] && while [ ! -f '${root}/release' ]; do sleep 0.05; done\ncase "$*" in`));
}
const callCount = (line: string) => readFileSync(join(root, "calls"), "utf8").split("\n").filter(call => call === line).length;
async function until(test: () => boolean) {
  while (!test()) await new Promise(resolve => setTimeout(resolve, 20));
}

it("reads Stack status during a turn, and a Stack write waits for a running gh stack view", async () => {
  const { host, backend, id } = await hostFixture();
  try {
    await host.send(id, "work", "now");
    assert.deepEqual(((await host.execute({ type: "stack_status", sessionId: id })) as StackStatus).view, view);
    backend.latest.completeTurn();
    holdGh("stack view --json");
    const reading = host.execute({ type: "stack_status", sessionId: id });
    await until(() => callCount("stack view --json") === 2);
    const rebasing = host.changeStack(id, { action: "rebase" });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(callCount("stack rebase"), 0);
    writeFileSync(join(root, "release"), "");
    assert.deepEqual(((await reading) as StackStatus).view, view);
    await rebasing;
    assert.equal(callCount("stack rebase"), 1);
  } finally { await host.shutdown(); }
});

it("starts the gh stack view of a Stack status only after a running Submit ends", async () => {
  const { host, id } = await hostFixture();
  try {
    const review = await host.prepareStack(id, "submit");
    holdGh("stack submit --auto");
    const submitting = host.changeStack(id, { action: "submit", token: review.token });
    await until(() => callCount("stack submit --auto") === 1);
    const views = callCount("stack view --json");
    const reading = host.execute({ type: "stack_status", sessionId: id });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(callCount("stack view --json"), views);
    writeFileSync(join(root, "release"), "");
    await submitting;
    assert.deepEqual(((await reading) as StackStatus).view, view);
    const calls = readFileSync(join(root, "calls"), "utf8").split("\n");
    assert.ok(calls.lastIndexOf("stack view --json") > calls.indexOf("stack submit --auto"));
  } finally { await host.shutdown(); }
});
