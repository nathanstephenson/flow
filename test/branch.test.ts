import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { reduceAll } from "../src/client/reduce.ts";
import { head } from "../src/daemon/git.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { git, repository } from "./git-fixture.ts";

/** Reporting the branch an Agent Session's Scope is on, and moving it. */
describe("branches", () => {
  let root: string;
  let work: string;
  let store: TranscriptStore;
  let host: SessionHost;
  let backend: FakeBackend;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "goodharness-state-"));
    work = mkdtempSync(join(tmpdir(), "goodharness-work-"));
    store = new TranscriptStore(root);
    backend = new FakeBackend();
    host = new SessionHost({ store });
    host.registerBackend(backend);
    await host.load();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const summaryOf = (id: string) => host.list().find((entry) => entry.id === id);
  const typesOf = (id: string) => host.logFor(id).since(0).map((entry) => entry.event.type);

  it("reports the branch a repository Scope is on", async () => {
    const repo = repository(work, "api", ["feature"]);
    const id = await host.create({ scope: repo, backend: "fake" });
    assert.deepEqual(summaryOf(id)?.branch, { name: "main" });
  });

  // Absent, not false: that is what lets a front-end hide the control rather than offer one that
  // cannot work. A Project need not be a repository at all.
  it("reports no branch for a Scope that is not a repository", async () => {
    const plain = join(work, "notes");
    mkdirSync(plain, { recursive: true });
    const id = await host.create({ scope: plain, backend: "fake" });

    assert.equal(summaryOf(id)?.branch, undefined);
    assert.equal(typesOf(id).includes("branch_changed"), false);
  });

  it("opens the transcript with session_started, never with the branch", async () => {
    const repo = repository(work, "api");
    const id = await host.create({ scope: repo, backend: "fake" });
    assert.equal(typesOf(id)[0], "session_started");
  });

  it("moves the working tree and records where it landed", async () => {
    const repo = repository(work, "api", ["feature"]);
    const id = await host.create({ scope: repo, backend: "fake" });

    const landed = await host.switchBranch(id, "feature");

    assert.deepEqual(landed, { name: "feature" });
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "feature");
    assert.deepEqual(summaryOf(id)?.branch, { name: "feature" });
    // A front-end reducing the transcript has to agree with what the host reports.
    assert.deepEqual(reduceAll(host.logFor(id).since(0)).branch, { name: "feature" });
  });

  it("refuses while a turn is in flight, and does not move the tree", async () => {
    const repo = repository(work, "api", ["feature"]);
    const id = await host.create({ scope: repo, backend: "fake" });
    await host.send(id, "get to work", "now");
    assert.equal(host.statusOf(id), "running");

    await assert.rejects(() => host.switchBranch(id, "feature"), /is running/);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "main");
  });

  it("refuses a Scope that is not a repository", async () => {
    const plain = join(work, "notes");
    mkdirSync(plain, { recursive: true });
    const id = await host.create({ scope: plain, backend: "fake" });

    await assert.rejects(() => host.switchBranch(id, "main"), /not a git repository/);
  });

  // git's judgement, not ours: it already refuses a checkout that would clobber a modified file,
  // and its own words explain it better than a message we invented.
  it("surfaces git's own refusal verbatim", async () => {
    const repo = repository(work, "api", ["feature"]);
    git(repo, "switch", "--quiet", "feature");
    writeFileSync(join(repo, "README.md"), "# on feature\n");
    git(repo, "commit", "--quiet", "-am", "diverge");
    git(repo, "switch", "--quiet", "main");
    const id = await host.create({ scope: repo, backend: "fake" });
    writeFileSync(join(repo, "README.md"), "# uncommitted\n");

    await assert.rejects(
      () => host.switchBranch(id, "feature"),
      /would be overwritten|local changes/i,
    );
  });

  describe("the staleness note", () => {
    it("rides along with the next message rather than becoming a turn of its own", async () => {
      const repo = repository(work, "api", ["feature"]);
      const id = await host.create({ scope: repo, backend: "fake" });

      await host.switchBranch(id, "feature");

      // No turn happened, and nothing is sitting in the Steering Queue waiting for one to end.
      assert.equal(host.statusOf(id), "idle");
      assert.equal(typesOf(id).includes("user_message"), false);
      assert.deepEqual(summaryOf(id)?.status, "idle");

      await host.send(id, "carry on", "now");

      const said = host
        .logFor(id)
        .since(0)
        .flatMap((entry) => (entry.event.type === "user_message" ? [entry.event.text] : []));
      assert.equal(said.length, 1, "one message, not two");
      assert.match(said[0] ?? "", /now on branch feature/);
      assert.match(said[0] ?? "", /carry on$/);
      // And the model was handed the same text the transcript shows.
      assert.equal(backend.latest.prompts.at(-1), said[0]);
    });

    it("is sent once, not on every message after the switch", async () => {
      const repo = repository(work, "api", ["feature"]);
      const id = await host.create({ scope: repo, backend: "fake" });
      await host.switchBranch(id, "feature");

      await host.send(id, "first", "now");
      await host.send(id, "second", "now");

      const said = host
        .logFor(id)
        .since(0)
        .flatMap((entry) => (entry.event.type === "user_message" ? [entry.event.text] : []));
      assert.equal(said.length, 2);
      assert.match(said[0] ?? "", /now on branch feature/);
      assert.doesNotMatch(said[1] ?? "", /now on branch/);
    });

    /**
     * The title is set from the first message while it is still the Scope, so a note riding along
     * with that message would have named the Agent Session after itself — and permanently, because
     * the rename never fires again.
     */
    it("does not become the Agent Session's title", async () => {
      const repo = repository(work, "api", ["feature"]);
      const id = await host.create({ scope: repo, backend: "fake" });
      await host.switchBranch(id, "feature");

      await host.send(id, "fix the login bug", "now");

      assert.equal(summaryOf(id)?.title, "fix the login bug");
    });
  });

  // Tools are pre-approved (ADR 0004), so the model can move the branch itself during a turn. A
  // reported branch that ignored that would be a stale claim a reader trusts.
  it("notices a branch the model moved, when the turn ends", async () => {
    const repo = repository(work, "api", ["feature"]);
    const id = await host.create({ scope: repo, backend: "fake" });
    assert.deepEqual(summaryOf(id)?.branch, { name: "main" });

    await host.send(id, "do something", "now");
    git(repo, "switch", "--quiet", "feature");
    backend.latest.completeTurn();

    // Waiting on the branch this asserts on, not on a tick: the refresh is deliberately off the
    // critical path and runs a subprocess, so no fixed number of microtasks proves it has landed.
    await waitFor(() => summaryOf(id)?.branch?.name === "feature");
    assert.deepEqual(await head(repo), { ok: true, value: { name: "feature" } });
  });

  it("records a change, and nothing at all for a turn that left the branch alone", async () => {
    const repo = repository(work, "api", ["feature"]);
    const id = await host.create({ scope: repo, backend: "fake" });

    // A turn that changes nothing.
    await host.send(id, "one", "now");
    backend.latest.completeTurn();
    await waitFor(() => host.statusOf(id) === "idle");

    // Then one that does, which is what makes the count below waitable rather than vacuous: this
    // test could otherwise pass by asserting before either refresh had run.
    await host.send(id, "two", "now");
    git(repo, "switch", "--quiet", "feature");
    backend.latest.completeTurn();
    await waitFor(() => summaryOf(id)?.branch?.name === "feature");

    const announced = typesOf(id).filter((type) => type === "branch_changed");
    assert.deepEqual(announced.length, 2, "the opening report and the one real change, no more");
  });
});

/**
 * Poll for the state under assertion, in the manner the other suites here settled on.
 *
 * What is waited on is a `refreshBranch` the host deliberately `void`s, so it is a subprocess rather
 * than a tick and no number of microtasks proves it has landed. The budget being generous is not
 * what makes this stable, though — the test above failed about one run in three until
 * `SessionRecord.branchGeneration` stopped two concurrent refreshes landing out of order, and it
 * failed just as often at 12 seconds as at 3. Left at a plain 5s, the value the other suites use.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
