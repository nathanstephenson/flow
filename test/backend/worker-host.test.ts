import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { SessionHost } from "../../src/daemon/host.ts";

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for worker lifecycle");
    await delay(20);
  }
}

test("fatal worker loss makes its Agent Session Dormant, closes owned work, and allows explicit Revive", async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-host-"));
  const host = new SessionHost();
  t.after(async () => { await host.shutdown(); await rm(scope, { recursive: true, force: true }); });
  host.registerBackend(new WorkerBackend({ backendModule: new URL("./worker-fixture.ts", import.meta.url).href }));
  const id = await host.create({ scope, backend: "pi" });
  // The prompt RPC has already returned when the worker dies: a pending request isn't required
  // to discover the loss, and the host must not leave independent Background Calls alive.
  await host.send(id, "late-crash", "now");
  await waitFor(() => host.logFor(id).since(0).some(({ event }) => event.type === "session_dormant"));
  assert.equal(host.list()[0]!.status, "dormant");
  assert.equal(host.list()[0]!.activeSubagents, 0);
  assert.equal(host.list()[0]!.activeBackgroundCalls, 0);
  const events = host.logFor(id).since(0).map(({ event }) => event);
  assert.ok(events.some((event) => event.type === "turn_ended" && event.reason === "error"));
  assert.ok(events.some((event) => event.type === "permission" && event.state === "aborted"));
  assert.equal(events.at(-1)!.type, "session_dormant");
  assert.equal(events.filter((event) => event.type === "session_started").length, 1);
  await host.revive(id);
  await host.send(id, "hello", "now");
  assert.equal(host.list()[0]!.status, "idle");
  assert.ok(host.logFor(id).since(0).some(({ event }) => event.type === "revived"));
});

test("a worker crash during a prompt is recorded once and shutdown waits for teardown", async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-host-"));
  const host = new SessionHost();
  t.after(async () => { await host.shutdown(); await rm(scope, { recursive: true, force: true }); });
  host.registerBackend(new WorkerBackend({ backendModule: new URL("./worker-fixture.ts", import.meta.url).href }));
  const id = await host.create({ scope, backend: "pi" });
  await assert.rejects(host.send(id, "crash", "now"), /worker (disconnected|exited)/i);
  await host.shutdown();
  const events = host.logFor(id).since(0).map(({ event }) => event);
  assert.equal(events.filter((event) => event.type === "notice" && event.level === "error").length, 1);
  assert.equal(events.filter((event) => event.type === "session_dormant").length, 1);
  assert.equal(host.list()[0]!.status, "dormant");
});
