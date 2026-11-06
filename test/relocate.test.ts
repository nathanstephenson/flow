import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { projectKey } from "../src/backend/worker/claude-state.ts";
import { WorkerBackend } from "../src/backend/worker/index.ts";
import { CommandRefused, SessionHost, suggestedScope } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { git, repository } from "./git-fixture.ts";

describe("relocate", () => {
  let root: string;
  let work: string;
  let store: TranscriptStore;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flow-state-")));
    work = realpathSync(mkdtempSync(join(tmpdir(), "flow-work-")));
    store = new TranscriptStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  async function hostWith(backend: "fake" | "claude" = "fake"): Promise<SessionHost> {
    const host = new SessionHost({ store });
    host.registerBackend(new FakeBackend());
    if (backend === "claude") host.registerBackend(new WorkerBackend({ backend: "claude" }));
    await host.load();
    return host;
  }

  /** A Dormant Agent Session whose Scope was moved away, as after a move to another machine. */
  async function dormantIn(scope: string, backend: "fake" | "claude" = "fake"): Promise<string> {
    const first = await hostWith();
    const id = await first.create({ scope, backend: "fake" });
    await first.shutdown();
    const meta = store.readMeta(id)!;
    store.writeMeta({ ...meta, backend });
    return id;
  }

  async function refusal(promise: Promise<unknown>): Promise<CommandRefused> {
    try { await promise; } catch (error) { assert.ok(error instanceof CommandRefused, String(error)); return error; }
    assert.fail("expected a refusal");
  }

  it("refuses a Revive when the Scope is gone, with scope_missing", async () => {
    const old = join(work, "old");
    mkdirSync(old);
    const id = await dormantIn(old);
    rmSync(old, { recursive: true });
    const host = await hostWith();

    const refused = await refusal(host.revive(id));
    assert.equal(refused.code, "scope_missing");
    assert.equal(host.list().find((entry) => entry.id === id)?.scopeMissing, true);
  });

  it("refuses while the old Scope still exists", async () => {
    const old = join(work, "old");
    mkdirSync(old);
    mkdirSync(join(work, "new"));
    const id = await dormantIn(old);
    const host = await hostWith();

    await refusal(host.execute({ type: "relocate", sessionId: id, scope: join(work, "new") }));
  });

  it("refuses a new Scope that does not exist", async () => {
    const old = join(work, "old");
    mkdirSync(old);
    const id = await dormantIn(old);
    rmSync(old, { recursive: true });
    const host = await hostWith();

    await refusal(host.execute({ type: "relocate", sessionId: id, scope: join(work, "missing") }));
    assert.equal(store.readMeta(id)?.scope, old);
  });

  it("moves the Claude record and the meta, and keeps them after a restart", async () => {
    const old = join(work, "old");
    mkdirSync(old);
    const id = await dormantIn(old, "claude");
    const records = join(store.backendDir(id), "claude-projects");
    mkdirSync(join(records, projectKey(old)), { recursive: true });
    writeFileSync(join(records, projectKey(old), "x.jsonl"), "{}\n");
    renameSync(old, join(work, "new"));
    const host = await hostWith("claude");

    await host.execute({ type: "relocate", sessionId: id, scope: join(work, "new") });

    assert.equal(existsSync(join(records, projectKey(join(work, "new")), "x.jsonl")), true);
    assert.equal(host.list().find((entry) => entry.id === id)?.scope, join(work, "new"));
    assert.equal(host.list().find((entry) => entry.id === id)?.scopeMissing, undefined);
    await host.shutdown();
    const again = await hostWith("claude");
    assert.equal(again.list().find((entry) => entry.id === id)?.scope, join(work, "new"));
  });

  it("refuses a Worktree session without a repository", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");
    const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
    const scope = host.list().find((entry) => entry.id === id)!.scope;
    await host.shutdown();
    renameSync(scope, join(work, "moved"));
    const after = await hostWith();

    await refusal(after.execute({ type: "relocate", sessionId: id, scope: join(work, "moved") }));
  });

  it("repairs the Worktree link when the repository and the Worktree both moved", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");
    const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
    const scope = host.list().find((entry) => entry.id === id)!.scope;
    await host.shutdown();
    renameSync(repo, join(work, "api-moved"));
    renameSync(scope, join(work, "tree-moved"));
    const after = await hostWith();

    await after.execute({ type: "relocate", sessionId: id, scope: join(work, "tree-moved"), repo: join(work, "api-moved") });

    assert.match(git(join(work, "tree-moved"), "status", "--porcelain=v1", "--branch"), /^## flow\//);
    assert.deepEqual(store.readMeta(id)?.worktree, { path: join(work, "tree-moved"), repo: join(work, "api-moved"),
      branch: store.readMeta(id)!.worktree!.branch });
  });

  it("refuses when git cannot repair the Worktree, and changes nothing", async () => {
    const host = await hostWith();
    const repo = repository(work, "api");
    const other = repository(work, "other");
    const id = await host.create({ scope: repo, backend: "fake", worktree: { from: "main" } });
    const scope = host.list().find((entry) => entry.id === id)!.scope;
    await host.shutdown();
    renameSync(scope, join(work, "tree-moved"));
    const after = await hostWith();

    await refusal(after.execute({ type: "relocate", sessionId: id, scope: join(work, "tree-moved"), repo: other }));
    assert.equal(store.readMeta(id)?.scope, scope);
  });

  it("suggests the same Worktree under this state root", () => {
    const worktrees = join(root, "worktrees");
    mkdirSync(join(worktrees, "api", "main-1"), { recursive: true });
    assert.equal(suggestedScope("/home/node/.flow/worktrees/api/main-1", worktrees), join(worktrees, "api", "main-1"));
    assert.equal(suggestedScope("/home/node/.flow/worktrees/api/main-2", worktrees), undefined);
    assert.equal(suggestedScope("/home/node/workspace/api", worktrees), undefined);
  });
});
