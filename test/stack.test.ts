import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { discoverStack, changeStack, cleanStack, parseStack, stackStatus, stackConflictMessage, stackFingerprint } from "../src/daemon/stack.ts";
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
  assert.deepEqual(available.view, view);
  assert.deepEqual(calls.at(-1), ["stack", "view", "--json"]);
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
    writeFileSync(join(root, "remote.json"), JSON.stringify([[remote]]));
    const executable = join(root, "bin/gh");
    writeFileSync(executable, readFileSync(executable, "utf8").replace("*) echo done;;", `api*) cat '${root}/remote.json';;\n*) echo done;;`));
    const review = await host.prepareStack(id, "sync");
    remote.pull_requests.push({ number: 13, head: { ref: "unreviewed" } });
    writeFileSync(join(root, "remote.json"), JSON.stringify([[remote]]));
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
  const mock = async () => JSON.stringify([[remote]]);
  const reviewed = await stackFingerprint(repo, view, true, mock);
  assert.equal(await stackFingerprint(repo, view, true, mock), reviewed);
  remote.pull_requests.push({ number: 13, head: { ref: "unreviewed" } });
  await assert.rejects(stackFingerprint(repo, view, true, mock), /Remote stack membership differs/);
  remote.pull_requests = [];
  await assert.rejects(stackFingerprint(repo, view, true, mock), /Remote stack membership differs/);
  await assert.rejects(stackFingerprint(repo, view, true, async () => { throw new Error("API unavailable"); }), /API unavailable/);
  assert.notEqual(await stackFingerprint(repo, view, true, async () => "[[]]"), reviewed);
});

function chain() {
  git(repo, "switch", "feature");
  git(repo, "commit", "--allow-empty", "-m", "feature");
  git(repo, "switch", "-c", "second");
  git(repo, "commit", "--allow-empty", "-m", "second");
}

it("offers and registers only an existing linear chain", async () => {
  assert.equal(await discoverStack(repo), undefined);
  chain();
  const candidate = (await discoverStack(repo))!;
  assert.deepEqual(candidate.branches, ["feature", "second"]);
  const calls: string[][] = [];
  await changeStack(repo, { action: "init", ...candidate }, async (_scope, args) => { calls.push(args); return "done"; });
  assert.deepEqual(calls, [["stack", "init", "--base", "main", "feature", "second"]]);
  git(repo, "switch", "main");
  assert.deepEqual((await discoverStack(repo))?.branches, candidate.branches);
});

it("omits siblings, equal tips, and tracked branches without guessing", async () => {
  chain();
  git(repo, "branch", "alias");
  assert.equal(await discoverStack(repo), undefined);
  git(repo, "branch", "-D", "alias");
  git(repo, "switch", "-c", "sibling", "feature");
  git(repo, "commit", "--allow-empty", "-m", "sibling");
  git(repo, "switch", "feature");
  assert.equal(await discoverStack(repo), undefined);
  git(repo, "switch", "main");
  assert.equal(await discoverStack(repo), undefined);
  git(repo, "branch", "-D", "sibling");
  writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "feature" }] }] }));
  assert.equal(await discoverStack(repo), undefined);
});

for (const change of ["deleted", "changed", "missing", "metadata"]) it(`refuses init after ${change} branches without creating anything`, async () => {
  chain();
  const candidate = (await discoverStack(repo))!;
  if (change === "deleted") git(repo, "branch", "-D", "feature");
  if (change === "changed") git(repo, "commit", "--allow-empty", "-m", "later");
  if (change === "missing") candidate.branches = ["missing", "second"];
  if (change === "metadata") writeFileSync(join(repo, ".git/gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "feature" }] }] }));
  const before = git(repo, "show-ref");
  await assert.rejects(changeStack(repo, { action: "init", ...candidate }, async () => { assert.fail("must not run"); }), /chain changed or is not eligible/);
  assert.equal(git(repo, "show-ref"), before);
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

it("uses the remote default and excludes unrelated branches", async () => {
  git(repo, "branch", "-m", "main", "develop");
  git(repo, "update-ref", "refs/remotes/origin/develop", "develop");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  chain();
  git(repo, "switch", "-c", "unrelated", "develop");
  git(repo, "commit", "--allow-empty", "-m", "unrelated");
  git(repo, "switch", "second");
  assert.equal((await discoverStack(repo))?.trunk, "develop");
  assert.deepEqual((await discoverStack(repo))?.branches, ["feature", "second"]);
  git(repo, "switch", "develop");
  assert.equal(await discoverStack(repo), undefined);
});

it("refuses a names-only init even when those branches exist", async () => {
  chain();
  await assert.rejects(changeStack(repo, { action: "init", branches: ["feature", "second"] }, async () => { assert.fail("must not run"); }), /chain changed or is not eligible/);
});
