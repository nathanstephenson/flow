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

it("creation choice wins, changes are confirmed and guarded, and persisted modes survive restart and Revive", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-permissions-"));
  const store = new TranscriptStore(root);
  let configured: "ask" | "always" = "ask";
  const backend = new FakeBackend();
  const modes: string[] = [];
  const adapter = { name: "pi", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
    modes.push(options.permissionMode ?? "missing");
    const session = await backend.create(options);
    session.setPermissionMode = async (mode) => { if (mode === "auto") throw Error("Pi Auto"); modes.push(mode); };
    return session;
  } };
  const makeHost = async () => { const host = new SessionHost({ store, defaultPermissionMode: () => configured }); host.registerBackend(adapter); await host.load(); return host; };
  try {
    const host = await makeHost();
    const id = await host.execute({ type: "create", scope: root, backend: "pi", permissionMode: "always" }) as string;
    assert.equal(host.list().find((item) => item.id === id)?.permissionMode, "always");
    await host.execute({ type: "set_permission_mode", sessionId: id, mode: "ask" });
    assert.equal(reduceAll(host.logFor(id).since(0)).permissionMode, "ask");
    await assert.rejects(host.setPermissionMode(id, "auto"), /does not support/);
    await host.send(id, "running", "now");
    await assert.rejects(host.setPermissionMode(id, "always"), /Finish the turn/);
    backend.latest.completeTurn();
    await host.shutdown();
    configured = "always";
    const restarted = await makeHost();
    assert.equal(restarted.list().find((item) => item.id === id)?.permissionMode, "ask");
    await restarted.revive(id);
    assert.equal(modes.at(-1), "ask");
    const next = await restarted.create({ scope: root, backend: "pi" });
    assert.equal(restarted.list().find((item) => item.id === next)?.permissionMode, "always");
    await restarted.shutdown();
    const meta = store.readMeta(id)!;
    delete meta.permissionMode;
    store.writeMeta(meta);
    configured = "always";
    const migrated = await makeHost();
    assert.equal(migrated.list().find((item) => item.id === id)?.permissionMode, "always");
    configured = "ask";
    await migrated.shutdown();
    const again = await makeHost();
    assert.equal(again.list().find((item) => item.id === id)?.permissionMode, "always");
    await again.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("Claude Auto fallback is specific to SDK Auto rejection, records effective Ask and warning", async () => {
  const backend = new FakeBackend();
  const host = new SessionHost();
  host.registerBackend({ name: "claude", create: async (options) => {
    if (options.permissionMode === "auto") throw new AutoPermissionUnavailable("unsupported by CLI");
    return backend.create(options);
  } });
  const id = await host.create({ scope: "/tmp", backend: "claude" });
  assert.equal(host.list()[0]?.permissionMode, "ask");
  assert.equal(reduceAll(host.logFor(id).since(0)).permissionMode, "ask");
  assert.ok(host.logFor(id).since(0).some(({ event }) => event.type === "notice" && event.level === "warn" && event.text.includes("Auto")));
  await host.shutdown();
});

it("a background Subagent prompt blocks changes after the parent turn, without deciding the prompt", async () => {
  const backend = new FakeBackend();
  let emit!: Parameters<FakeBackend["create"]>[0]["emit"];
  const host = new SessionHost();
  host.registerBackend({ name: "pi", create: async (options) => { emit = options.emit; const session = await backend.create(options); session.setPermissionMode = async () => {}; return session; } });
  const id = await host.create({ scope: "/tmp", backend: "pi", permissionMode: "ask" });
  await host.send(id, "delegate", "now");
  const child = backend.latest.beginSubagent("writer");
  child.launch();
  backend.latest.completeTurn();
  const callId = "background-write";
  emit({ type: "permission", callId, tool: "write", producer: { subagentId: child.subagentId }, state: "asked" });
  await assert.rejects(host.setPermissionMode(id, "always"), /Permission Prompts/);
  assert.equal(host.list()[0]?.permissionMode, "ask");
  assert.ok(host.logFor(id).since(0).some(({ event }) => event.type === "permission" && event.callId === callId && event.state === "asked"));
  emit({ type: "permission", callId, tool: "write", producer: { subagentId: child.subagentId }, state: "aborted" });
  await host.setPermissionMode(id, "always");
  assert.equal(host.list()[0]?.permissionMode, "always");
  await host.shutdown();
});

it("Claude Auto refusal on Revive and live change is visible and never retained as Auto", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-claude-auto-fallback-"));
  const store = new TranscriptStore(root);
  const fake = new FakeBackend();
  let refuse = false;
  const adapter = { name: "claude", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
    if (refuse && options.permissionMode === "auto") throw new AutoPermissionUnavailable("Auto unsupported");
    const session = await fake.create(options);
    session.setPermissionMode = async (mode) => { if (refuse && mode === "auto") throw new Error("Auto unsupported"); };
    return session;
  } };
  const host = new SessionHost({ store });
  host.registerBackend(adapter);
  try {
    const id = await host.create({ scope: root, backend: "claude" });
    assert.equal(host.list()[0]?.permissionMode, "auto");
    await host.shutdown();
    refuse = true;
    const revived = new SessionHost({ store });
    revived.registerBackend(adapter);
    await revived.load();
    await revived.revive(id);
    assert.equal(revived.list()[0]?.permissionMode, "ask");
    assert.equal(store.readMeta(id)?.permissionMode, "ask");
    await revived.setPermissionMode(id, "always");
    await revived.setPermissionMode(id, "auto");
    assert.equal(revived.list()[0]?.permissionMode, "ask");
    assert.equal(store.readMeta(id)?.permissionMode, "ask");
    assert.ok(revived.logFor(id).since(0).filter(({ event }) => event.type === "notice" && event.level === "warn" && event.text.includes("Auto")).length >= 2);
    await revived.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
