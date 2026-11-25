import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Session Host shutdown waits for adapter shutdown after stopping Backend Sessions", { timeout: 5000 }, async () => {
  const host = new SessionHost();
  const backend = new FakeBackend();
  const started = deferred();
  const finish = deferred();
  host.registerBackend({
    name: backend.name,
    create: options => backend.create(options),
    async shutdown() {
      assert.equal(backend.latest.disposed, true);
      started.resolve();
      await finish.promise;
    },
  });
  await host.create({ scope: tmpdir(), backend: backend.name });
  let stopped = false;
  const stopping = host.shutdown().then(() => { stopped = true; });
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(host.list()[0]?.status, "dormant");
  } finally { finish.resolve(); }
  await stopping;
  assert.equal(stopped, true);
});

test("Session Host shutdown drains all adapters before reporting a shutdown failure", { timeout: 5000 }, async () => {
  const host = new SessionHost();
  const failure = new Error("Synthetic adapter shutdown failure");
  const started = deferred();
  const finish = deferred();
  const backend = new FakeBackend();
  host.registerBackend({ name: "fails", create: options => backend.create(options), async shutdown() { throw failure; } });
  host.registerBackend({ name: "drains", create: options => backend.create(options), async shutdown() { started.resolve(); await finish.promise; } });
  let stopped = false;
  const stopping = host.shutdown();
  const rejected = assert.rejects(stopping, (error: AggregateError) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  void stopping.then(() => { stopped = true; }, () => { stopped = true; });
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
  } finally { finish.resolve(); }
  await rejected;
});
