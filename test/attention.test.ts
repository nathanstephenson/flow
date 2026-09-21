import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";

async function fixture(root?: string) {
  const backend = new FakeBackend({ enquiries: true, permissions: true });
  const host = new SessionHost(root ? { store: new TranscriptStore(root) } : {});
  host.registerBackend(backend);
  const id = await host.create({ scope: "/tmp/attention", backend: "fake" });
  return { backend, host, id };
}

async function complete(host: SessionHost, backend: FakeBackend, id: string, reason: "complete" | "error" = "complete") {
  await host.send(id, "go", "now");
  backend.latest.completeTurn(reason);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("attention inbox", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("updates the output preview as a streamed message grows without moving the row", async () => {
    const { backend, host, id } = await fixture();
    const other = await host.create({ scope: "/tmp/other", backend: "fake" });
    await host.send(id, "go", "now");
    const before = host.list().map((session) => session.id);

    backend.sessions[0]!.say("first\nline", false);
    assert.equal(host.list().find((session) => session.id === id)?.outputPreview, "first line");
    backend.sessions[0]!.say("first line continues", false);
    assert.equal(host.list().find((session) => session.id === id)?.outputPreview, "first line continues");
    assert.deepEqual(host.list().map((session) => session.id), before);
    assert.ok(before.includes(other));
  });

  it("qualifies parent outcomes and acknowledges only the observed version", async () => {
    const { backend, host, id } = await fixture();
    await complete(host, backend, id);
    const first = host.list()[0]?.attention;
    assert.equal(first?.group, "unread");
    assert.equal(first?.reason, "Completed");

    await complete(host, backend, id, "error");
    const newer = host.list()[0]?.attention;
    assert.equal(newer?.reason, "Failed");
    assert.ok(newer && first && newer.version > first.version);

    host.acknowledge(id, first!.version);
    assert.equal(host.list()[0]?.attention?.version, newer?.version, "late acknowledgement leaves newer output unread");
    host.acknowledge(id, newer!.version);
    assert.equal(host.list()[0]?.attention, undefined);
  });

  it("keeps an acknowledged unresolved request in Needs input without changing occupancy", async () => {
    const { backend, host, id } = await fixture();
    const callId = backend.latest.askPermission("Bash");
    const attention = host.list()[0]?.attention;
    assert.equal(attention?.group, "needs-input");
    assert.equal(host.list()[0]?.status, "awaiting");

    host.acknowledge(id, attention!.version);
    assert.equal(host.list()[0]?.attention?.group, "needs-input", "read is not resolved");
    await host.answerPermission(id, callId, "deny");
    assert.equal(host.list()[0]?.attention, undefined);
  });

  it("restores an unread outcome after a later request resolves without acknowledgement", async () => {
    const { backend, host, id } = await fixture();
    await complete(host, backend, id, "error");
    const failure = host.list()[0]!.attention!;
    await host.send(id, "try again", "now");
    const callId = backend.latest.askPermission("Bash");
    assert.equal(host.list()[0]?.attention?.group, "needs-input");

    await host.answerPermission(id, callId, "deny");
    assert.deepEqual(host.list()[0]?.attention, failure);
    backend.latest.completeTurn("aborted");
    assert.deepEqual(host.list()[0]?.attention, failure);
    host.acknowledge(id, failure.version);
    assert.equal(host.list()[0]?.attention, undefined);
  });

  it("retains an unread outcome across restart with an unanswered newer request", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-attention-input-"));
    roots.push(root);
    const { backend, host, id } = await fixture(root);
    await complete(host, backend, id, "error");
    const failure = host.list()[0]!.attention!;
    await host.send(id, "try again", "now");
    backend.latest.askPermission("Bash");
    await host.shutdown();

    const restarted = new SessionHost({ store: new TranscriptStore(root) });
    restarted.registerBackend(new FakeBackend());
    await restarted.load();
    assert.deepEqual(restarted.list()[0]?.attention, failure);
    restarted.acknowledge(id, failure.version);
    assert.equal(restarted.list()[0]?.attention, undefined);
  });

  it("acknowledges earlier outcomes when observing a newer pending request", async () => {
    const { backend, host, id } = await fixture();
    await complete(host, backend, id, "error");
    await host.send(id, "try again", "now");
    const callId = backend.latest.askPermission("Bash");
    host.acknowledge(id, host.list()[0]!.attention!.version);
    await host.answerPermission(id, callId, "deny");
    assert.equal(host.list()[0]?.attention, undefined);
    backend.latest.completeTurn("complete");
    assert.equal(host.list()[0]?.attention?.reason, "Completed");
  });

  it("ignores successful independent work and qualifies standalone failures", async () => {
    const { backend, host, id } = await fixture();
    const succeeded = backend.latest.beginSubagent("success");
    succeeded.finish("complete");
    assert.equal(host.list()[0]?.attention, undefined);

    const failed = backend.latest.beginSubagent("failure");
    failed.finish("error");
    assert.equal(host.list()[0]?.attention?.reason, "Failed");
    const failure = host.list()[0]!.attention!;
    host.acknowledge(id, failure.version);

    const call = backend.latest.backgroundCall();
    call.settle("complete");
    assert.equal(host.list()[0]?.attention, undefined);
    const broken = backend.latest.backgroundCall();
    broken.settle("error");
    assert.equal(host.list()[0]?.attention?.reason, "Failed");
  });

  it("persists one machine-wide read boundary and Settle clears unread", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-attention-"));
    roots.push(root);
    const { backend, host, id } = await fixture(root);
    await complete(host, backend, id);
    const version = host.list()[0]!.attention!.version;
    host.acknowledge(id, version);
    await host.shutdown();

    const restarted = new SessionHost({ store: new TranscriptStore(root) });
    restarted.registerBackend(new FakeBackend());
    await restarted.load();
    assert.equal(restarted.list()[0]?.attention, undefined, "read state survives restart and is shared by every client");

    await restarted.revive(id);
    // Direct Workflow completion exercises the same durable attention record.
    restarted.workflowComplete(id, "workflow-1");
    assert.equal(restarted.list()[0]?.attention?.reason, "Completed");
    const restingAt = restarted.list()[0]!.restingAt;
    await restarted.settle(id);
    assert.equal(restarted.list()[0]?.attention, undefined);
    assert.equal(restarted.list()[0]?.status, "settled");
    assert.equal(restarted.list()[0]?.restingAt, restingAt, "acknowledgement does not change Resting");
  });

  it("does not republish older workflow outcomes after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-attention-workflows-"));
    roots.push(root);
    const { host, id } = await fixture(root);
    host.workflowComplete(id, "workflow-1");
    host.workflowWake(id, "workflow-2", "revision-1");
    const version = host.list()[0]!.attention!.version;
    await host.shutdown();

    const store = new TranscriptStore(root);
    const restarted = new SessionHost({ store });
    restarted.registerBackend(new FakeBackend());
    await restarted.load();
    const notices = () => store.readEntries(id).filter((entry) => entry.event.type === "notice").length;
    const before = notices();

    restarted.workflowComplete(id, "workflow-1");
    restarted.workflowWake(id, "workflow-2", "revision-1");
    assert.equal(notices(), before);
    assert.equal(restarted.list()[0]?.attention?.version, version);
  });

  it("End clears unread while preserving its terminal lifecycle", async () => {
    const { backend, host, id } = await fixture();
    await complete(host, backend, id, "error");
    assert.equal(host.list()[0]?.attention?.reason, "Failed");

    await host.dispose(id, "ended under test");
    assert.equal(host.list()[0]?.attention, undefined);
    assert.equal(host.list()[0]?.status, "ended");
  });

  it("migrates records without attention metadata as already read", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-attention-legacy-"));
    roots.push(root);
    const { backend, host, id } = await fixture(root);
    await complete(host, backend, id);
    await host.shutdown();
    const path = join(root, "sessions", id, "meta.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.latestAttention;
    delete legacy.latestOutcome;
    delete legacy.readAttentionVersion;
    writeFileSync(path, JSON.stringify(legacy));

    const restarted = new SessionHost({ store: new TranscriptStore(root) });
    restarted.registerBackend(new FakeBackend());
    await restarted.load();
    assert.equal(restarted.list()[0]?.attention, undefined);
  });

  it("loads unread outcomes from metadata written before the separate outcome boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-attention-outcome-"));
    roots.push(root);
    const { backend, host, id } = await fixture(root);
    await complete(host, backend, id, "error");
    const failure = host.list()[0]!.attention!;
    await host.shutdown();
    const path = join(root, "sessions", id, "meta.json");
    const meta = JSON.parse(readFileSync(path, "utf8"));
    delete meta.latestOutcome;
    writeFileSync(path, JSON.stringify(meta));

    const restarted = new SessionHost({ store: new TranscriptStore(root) });
    restarted.registerBackend(new FakeBackend());
    await restarted.load();
    assert.deepEqual(restarted.list()[0]?.attention, failure);
  });

  it("orders Needs input then Unread by qualifying age, ahead of activity bands", async () => {
    const { backend, host, id: idle } = await fixture();
    const unread = await host.create({ scope: "/tmp/unread", backend: "fake" });
    await complete(host, backend, unread);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const input = await host.create({ scope: "/tmp/input", backend: "fake" });
    backend.latest.askPermission("Write");

    assert.deepEqual(host.list().slice(0, 3).map((session) => session.id), [input, unread, idle]);
  });
});
