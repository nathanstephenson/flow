import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { reduceAll } from "../src/client/reduce.ts";
import { AutoPermissionUnavailable } from "../src/backend/claude/index.ts";
import type { AgentPermissionMode } from "../src/protocol/events.ts";
import { git, repository } from "./git-fixture.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("a permission selection during Revive waits for the backend and updates its actual policy", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-permission-revive-race-"));
  const store = new TranscriptStore(root);
  const fake = new FakeBackend();
  const entered = gate(), release = gate();
  let hold = false;
  let effective: AgentPermissionMode | undefined;
  const adapter = { name: "pi", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
    const initial = options.permissionMode;
    if (hold) { entered.resolve(); await release.promise; }
    const session = await fake.create(options);
    effective = initial;
    session.setPermissionMode = async (mode) => { effective = mode; };
    return session;
  } };
  const first = new SessionHost({ store }); first.registerBackend(adapter);
  const restarted = new SessionHost({ store }); restarted.registerBackend(adapter);
  try {
    const id = await first.create({ scope: root, backend: "pi", permissionMode: "always" });
    await first.shutdown();
    await restarted.load(); hold = true;
    const reviving = restarted.revive(id);
    await entered.promise;
    const changing = restarted.setPermissionMode(id, "ask");
    await tick();
    assert.equal(restarted.list()[0]?.permissionMode, "always", "a selection is not confirmed before backend startup");
    release.resolve();
    await Promise.all([reviving, changing]);
    assert.equal(effective, "ask");
    assert.equal(store.readMeta(id)?.permissionMode, "ask");
    assert.equal(reduceAll(restarted.logFor(id).since(0)).permissionMode, "ask");
  } finally { release.resolve(); await first.shutdown(); await restarted.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

it("Revive submitted after a Dormant permission selection starts with the selected policy", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-permission-before-revive-"));
  const store = new TranscriptStore(root);
  const fake = new FakeBackend();
  const created: Array<AgentPermissionMode | undefined> = [];
  const adapter = { name: "pi", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
    created.push(options.permissionMode); return fake.create(options);
  } };
  const first = new SessionHost({ store }); first.registerBackend(adapter);
  const restarted = new SessionHost({ store }); restarted.registerBackend(adapter);
  try {
    const id = await first.create({ scope: root, backend: "pi", permissionMode: "always" });
    await first.shutdown(); await restarted.load();
    await Promise.all([restarted.setPermissionMode(id, "ask"), restarted.revive(id)]);
    assert.deepEqual(created, ["always", "ask"]);
    assert.equal(restarted.list()[0]?.permissionMode, "ask");
  } finally { await first.shutdown(); await restarted.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ["send", "compact"] as const) {
  it(`${action} waits for a live permission transition before starting a turn`, { timeout: 5000 }, async () => {
    const fake = new FakeBackend({ compaction: true });
    const host = new SessionHost();
    const entered = gate(), release = gate();
    let effective: AgentPermissionMode | undefined;
    host.registerBackend({ name: "pi", create: async (options) => {
      const session = await fake.create(options);
      effective = options.permissionMode;
      session.setPermissionMode = async (mode) => { entered.resolve(); await release.promise; effective = mode; };
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => { assert.equal(effective, "ask"); await prompt(...args); };
      const compact = session.compact!.bind(session);
      session.compact = async (...args) => { assert.equal(effective, "ask"); await compact(...args); };
      return session;
    } });
    try {
      const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "always" });
      const changing = host.setPermissionMode(id, "ask");
      await entered.promise;
      const starting = action === "send" ? host.send(id, "start", "now") : host.compact(id);
      await tick();
      assert.deepEqual(fake.latest.prompts, []);
      assert.deepEqual(fake.latest.compactions, []);
      assert.equal(host.list()[0]?.permissionMode, "always");
      release.resolve(); await Promise.all([changing, starting]);
      assert.equal(host.list()[0]?.permissionMode, "ask");
    } finally { release.resolve(); await host.shutdown(); }
  });
}

it("permission changes are serialized and concurrent after-turn sends retain Steering Queue ordering", { timeout: 5000 }, async () => {
  const fake = new FakeBackend();
  const host = new SessionHost();
  const entered = gate(), release = gate();
  const modes: AgentPermissionMode[] = [];
  host.registerBackend({ name: "pi", create: async (options) => {
    const session = await fake.create(options);
    session.setPermissionMode = async (mode) => {
      modes.push(mode);
      if (modes.length === 1) { entered.resolve(); await release.promise; }
    };
    return session;
  } });
  try {
    const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "always" });
    const first = host.setPermissionMode(id, "ask"); await entered.promise;
    const second = host.setPermissionMode(id, "always");
    const sendOne = host.send(id, "first", "after_turn"), sendTwo = host.send(id, "second", "after_turn");
    await tick(); assert.deepEqual(modes, ["ask"]);
    release.resolve(); await Promise.all([first, second, sendOne, sendTwo]);
    assert.deepEqual(modes, ["ask", "always"]);
    assert.deepEqual(fake.latest.prompts, ["first"]);
    assert.deepEqual(reduceAll(host.logFor(id).since(0)).queue, ["second"]);
    fake.latest.completeTurn(); await tick();
    assert.deepEqual(fake.latest.prompts, ["first", "second"]);
  } finally { release.resolve(); await host.shutdown(); }
});

it("a failed permission transition releases waiting sends using the last confirmed policy", { timeout: 5000 }, async () => {
  const fake = new FakeBackend();
  const host = new SessionHost();
  const entered = gate(), release = gate();
  host.registerBackend({ name: "pi", create: async (options) => {
    const session = await fake.create(options);
    session.setPermissionMode = async () => { entered.resolve(); await release.promise; throw new Error("transition rejected"); };
    return session;
  } });
  try {
    const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "ask" });
    const changing = assert.rejects(host.setPermissionMode(id, "always"), /transition rejected/); await entered.promise;
    const sending = host.send(id, "still send", "now");
    release.resolve(); await Promise.all([changing, sending]);
    assert.equal(host.list()[0]?.permissionMode, "ask");
    assert.deepEqual(fake.latest.prompts, ["still send"]);
  } finally { release.resolve(); await host.shutdown(); }
});

for (const restart of [false, true]) {
  it(`a failed Auto fallback Revive durably confirms Ask before ${restart ? "restart" : "retry"}`, { timeout: 5000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-permission-failed-fallback-"));
    const store = new TranscriptStore(root);
    const fake = new FakeBackend();
    let refuseAuto = false, failAsk = false;
    const adapter = { name: "claude", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
      if (refuseAuto && options.permissionMode === "auto") throw new AutoPermissionUnavailable("Auto unsupported");
      if (failAsk) throw new Error("Ask backend unavailable");
      return fake.create(options);
    } };
    const first = new SessionHost({ store }); first.registerBackend(adapter);
    let restarted = new SessionHost({ store }); restarted.registerBackend(adapter);
    try {
      const id = await first.create({ scope: root, backend: "claude" }); await first.shutdown();
      await restarted.load(); refuseAuto = true; failAsk = true;
      await assert.rejects(restarted.revive(id), /Ask backend unavailable/);
      assert.equal(store.readMeta(id)?.permissionMode, "ask");
      assert.equal(reduceAll(restarted.logFor(id).since(0)).permissionMode, "ask");
      assert.ok(restarted.logFor(id).since(0).some(({ event }) => event.type === "notice" && event.level === "warn" && event.text.includes("Auto")));
      if (restart) {
        await restarted.shutdown(); restarted = new SessionHost({ store }); restarted.registerBackend(adapter); await restarted.load();
      }
      failAsk = false; await restarted.revive(id);
      assert.equal(restarted.list()[0]?.permissionMode, "ask");
      assert.equal(reduceAll(restarted.logFor(id).since(0)).permissionMode, "ask");
      assert.equal(restarted.logFor(id).since(0).filter(({ event }) => event.type === "permission_mode_changed" && event.mode === "ask").length, 1);
    } finally { await first.shutdown(); await restarted.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const activity of ["turn", "completed turn", "prompt", "completed prompt"] as const) {
  it(`SDK-owned ${activity} during a permission transition refuses and rolls back the selection`, { timeout: 5000 }, async () => {
    const fake = new FakeBackend();
    const host = new SessionHost();
    const entered = gate(), release = gate();
    const modes: AgentPermissionMode[] = [];
    let emit!: Parameters<FakeBackend["create"]>[0]["emit"];
    host.registerBackend({ name: "pi", create: async (options) => {
      emit = options.emit;
      const session = await fake.create(options);
      session.setPermissionMode = async (mode) => {
        modes.push(mode);
        if (modes.length === 1) { entered.resolve(); await release.promise; }
      };
      return session;
    } });
    try {
      const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "ask" });
      const rejected = assert.rejects(host.setPermissionMode(id, "always"), /interrupted/);
      await entered.promise;
      if (activity.endsWith("turn")) {
        fake.latest.startTurn();
        if (activity === "completed turn") fake.latest.completeTurn();
      } else {
        emit({ type: "tool_started", callId: "child-write", name: "write", input: {}, producer: { subagentId: "child" } });
        emit({ type: "permission", callId: "child-write", tool: "write", producer: { subagentId: "child" }, state: "asked" });
        if (activity === "completed prompt") emit({ type: "permission", callId: "child-write", tool: "write", producer: { subagentId: "child" }, state: "decided", decision: "allow" });
      }
      release.resolve(); await rejected;
      assert.deepEqual(modes, ["always", "ask"]);
      assert.equal(host.list()[0]?.permissionMode, "ask");
      assert.equal(reduceAll(host.logFor(id).since(0)).permissionMode, "ask");
      assert.equal(host.logFor(id).since(0).filter(({ event }) => event.type === "permission_mode_changed").length, 0);
      if (activity === "prompt") assert.equal(reduceAll(host.logFor(id).since(0)).authorising?.callId, "child-write");
    } finally { release.resolve(); await host.shutdown(); }
  });
}

it("an interrupted Auto-to-Ask fallback restores the prior mode without a false fallback warning", { timeout: 5000 }, async () => {
  const fake = new FakeBackend();
  const host = new SessionHost();
  const entered = gate(), release = gate();
  const modes: AgentPermissionMode[] = [];
  host.registerBackend({ name: "claude", create: async (options) => {
    const session = await fake.create(options);
    session.setPermissionMode = async (mode) => {
      modes.push(mode);
      if (mode === "auto") throw new Error("Auto unavailable");
      if (mode === "ask") { entered.resolve(); await release.promise; }
    };
    return session;
  } });
  try {
    const id = await host.create({ scope: "/tmp", backend: "claude", permissionMode: "always" });
    const rejected = assert.rejects(host.setPermissionMode(id, "auto"), /interrupted/);
    await entered.promise; fake.latest.startTurn(); fake.latest.completeTurn();
    release.resolve(); await rejected;
    assert.deepEqual(modes, ["auto", "ask", "always"]);
    assert.equal(host.list()[0]?.permissionMode, "always");
    assert.ok(!host.logFor(id).since(0).some(({ event }) => event.type === "notice" && event.text.includes("Using Ask")));
  } finally { release.resolve(); await host.shutdown(); }
});

it("a failed policy rollback stops the backend instead of claiming its policy is confirmed", { timeout: 5000 }, async () => {
  const fake = new FakeBackend();
  const host = new SessionHost();
  const entered = gate(), release = gate();
  let calls = 0;
  host.registerBackend({ name: "pi", create: async (options) => {
    const session = await fake.create(options);
    session.setPermissionMode = async () => {
      if (++calls > 1) throw new Error("rollback rejected");
      entered.resolve(); await release.promise;
    };
    return session;
  } });
  try {
    const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "ask" });
    const rejected = assert.rejects(host.setPermissionMode(id, "always"), /interrupted/);
    await entered.promise; fake.latest.startTurn(); release.resolve(); await rejected;
    assert.equal(fake.latest.disposed, true);
    assert.equal(host.list()[0]?.status, "dormant");
    assert.equal(host.list()[0]?.permissionMode, "ask");
    assert.equal(reduceAll(host.logFor(id).since(0)).status, "dormant");
    assert.ok(host.logFor(id).since(0).some(({ event }) => event.type === "notice" && event.text.includes("rollback rejected")));
  } finally { release.resolve(); await host.shutdown(); }
});

it("Ending a Backend Session during a policy transition cannot confirm the stale selection", { timeout: 5000 }, async () => {
  const fake = new FakeBackend();
  const host = new SessionHost();
  const entered = gate(), release = gate();
  host.registerBackend({ name: "pi", create: async (options) => {
    const session = await fake.create(options);
    session.setPermissionMode = async () => { entered.resolve(); await release.promise; };
    return session;
  } });
  try {
    const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "ask" });
    const rejected = assert.rejects(host.setPermissionMode(id, "always"), /interrupted/);
    await entered.promise; await host.dispose(id); release.resolve(); await rejected;
    assert.equal(host.list()[0]?.status, "ended");
    assert.equal(host.list()[0]?.permissionMode, "ask");
    assert.equal(host.logFor(id).since(0).at(-1)?.event.type, "session_ended");
  } finally { release.resolve(); await host.shutdown(); }
});

for (const lifecycle of ["ended", "settled"] as const) {
  it(`an Agent Session ${lifecycle} during failed policy rollback cannot become Dormant again`, { timeout: 5000 }, async () => {
    const fake = new FakeBackend();
    const host = new SessionHost();
    const entered = gate(), release = gate(), enteredRollback = gate(), releaseRollback = gate();
    let calls = 0;
    host.registerBackend({ name: "pi", create: async (options) => {
      const session = await fake.create(options);
      session.setPermissionMode = async () => {
        if (++calls === 1) { entered.resolve(); await release.promise; }
        else { enteredRollback.resolve(); await releaseRollback.promise; throw new Error("rollback rejected"); }
      };
      return session;
    } });
    try {
      const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "ask" });
      const rejected = assert.rejects(host.setPermissionMode(id, "always"), /interrupted/);
      await entered.promise; fake.latest.startTurn(); release.resolve(); await enteredRollback.promise;
      await (lifecycle === "ended" ? host.dispose(id) : host.settle(id));
      releaseRollback.resolve(); await rejected;
      assert.equal(host.list()[0]?.status, lifecycle);
      assert.equal(reduceAll(host.logFor(id).since(0)).status, lifecycle);
      assert.equal(host.list()[0]?.permissionMode, "ask");
      assert.equal(host.logFor(id).since(0).at(-1)?.event.type, lifecycle === "ended" ? "session_ended" : "session_settled");
    } finally { release.resolve(); releaseRollback.resolve(); await host.shutdown(); }
  });
}

it("workflow parent notifications wait for permission confirmation without being consumed", { timeout: 5000 }, async () => {
  const fake = new FakeBackend();
  const host = new SessionHost();
  const entered = gate(), release = gate();
  let consumed = 0;
  host.workflowOwner = {
    active: () => 0, stop: async () => {}, forget: async () => {}, context: () => "",
    parent: () => { throw new Error("unused"); }, takeNotification: () => undefined,
    takeCompletion: () => { consumed++; return "workflow completed"; },
  };
  host.registerBackend({ name: "pi", create: async (options) => {
    const session = await fake.create(options);
    session.setPermissionMode = async () => { entered.resolve(); await release.promise; };
    return session;
  } });
  try {
    const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "always" });
    const changing = host.setPermissionMode(id, "ask"); await entered.promise;
    host.workflowComplete(id, "workflow"); await tick();
    assert.equal(consumed, 0); assert.deepEqual(fake.latest.prompts, []);
    release.resolve(); await changing; await tick();
    assert.equal(consumed, 1); assert.deepEqual(fake.latest.prompts, ["workflow completed"]);
    assert.equal(host.list()[0]?.permissionMode, "ask");
  } finally { release.resolve(); await host.shutdown(); }
});

it("invalid creation permissions are rejected before cutting a worktree or branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-permission-invalid-worktree-"));
  const work = mkdtempSync(join(tmpdir(), "flow-permission-invalid-repo-"));
  const host = new SessionHost({ store: new TranscriptStore(root) });
  const fake = new FakeBackend(); host.registerBackend({ name: "pi", create: (options) => fake.create(options) });
  try {
    const repo = repository(work, "api");
    const before = git(repo, "worktree", "list", "--porcelain");
    await assert.rejects(host.create({ scope: repo, backend: "pi", permissionMode: "auto", worktree: { from: "main", branch: "invalid-policy" } }), /does not support/);
    assert.equal(git(repo, "worktree", "list", "--porcelain"), before);
    assert.ok(!git(repo, "branch", "--list", "invalid-policy").trim());
    assert.deepEqual(host.list(), []);
    assert.deepEqual(fake.sessions, []);
  } finally { await host.shutdown(); rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
});
