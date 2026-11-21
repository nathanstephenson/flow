import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { BackendCreateOptions } from "../src/backend/types.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { probeModels } from "../src/daemon/models.ts";

it("builder model discovery uses only the selected backend and does not reuse ordinary probes", async t => {
  const host = new SessionHost();
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  const opened: BackendCreateOptions[] = [];
  host.registerBackend({ name: "fake", create: async options => {
    opened.push(options);
    const session = await fake.create(options);
    session.prompt = async () => { assert.fail("Model discovery must not prompt"); };
    return session;
  } });
  const ordinary = await host.models("/tmp");
  host.registerBackend({ name: "other", create: async () => { throw new Error("Unselected backend was opened"); } });
  const listing = await host.workflowBuilderModels("fake", "/tmp");
  assert.deepEqual(listing, ordinary[0]);
  assert.equal(opened.length, 2);
  assert.equal(opened[0]!.workflowBuilder, undefined);
  const builder = opened[1]!.workflowBuilder;
  assert.ok(builder);
  assert.equal(opened[1]!.scope, "/tmp");
  assert.equal(opened[1]!.tools, "none");
  for (const method of ["read", "list", "write"] as const) {
    await assert.rejects(builder[method]("unused"), /Model discovery cannot use workflow builder tools/);
  }
  assert.equal(fake.latest.disposed, true);
});

it("Check again requests catalog refresh while ordinary model discovery stays cached", async t => {
  const host = new SessionHost();
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  const opened: BackendCreateOptions[] = [];
  host.registerBackend({ name: "fake", create: async options => {
    opened.push(options);
    const session = await fake.create(options);
    session.prompt = async () => { assert.fail("Model discovery must not prompt"); };
    return session;
  } });
  await host.models("/tmp");
  await host.models("/tmp");
  assert.deepEqual(opened.map(options => options.refreshModels), [undefined]);
  await host.models("/tmp", true);
  await host.models("/tmp");
  assert.deepEqual(opened.map(options => options.refreshModels), [undefined, true]);
});

it("late Pi model probes cannot replace a newer catalog and failed startup retains the cache", async t => {
  const host = new SessionHost();
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const states: string[] = [];
  host.registerBackend({ name: "pi", async create(options) {
    assert.ok(options.stateDir);
    const path = join(options.stateDir, "models-store.json");
    states.push(options.stateDir);
    const attempt = states.length;
    if (attempt === 1) await gate;
    if (attempt === 2) assert.equal(readFileSync(path, "utf8"), "{}");
    if (attempt >= 3) assert.equal(readFileSync(path, "utf8"), '{"catalog":"new"}');
    writeFileSync(path, attempt === 2 ? '{"catalog":"new"}' : '{"catalog":"old"}');
    if (attempt === 3) throw new Error("Probe failed after writing its private catalog");
    return fake.create(options);
  } });
  const first = host.models("/tmp");
  await host.models("/tmp", true);
  release();
  await first;
  assert.match((await host.models("/tmp", true))[0]!.problem!, /Probe failed/);
  assert.equal(existsSync(states[2]!), false);
  await host.models("/tmp", true);
  assert.equal(new Set(states).size, 4);
  await host.shutdown();
  assert.ok(states.every(path => !existsSync(path)));
});

for (const replacement of ["symbolic link", "hard link", "directory link"] as const) {
  it(`Pi catalog retention does not follow a worker-created ${replacement}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "flow-model-cache-link-"));
    const secret = join(root, "models-store.json");
    writeFileSync(secret, '{"private":"synthetic-secret"}');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const host = new SessionHost();
    t.after(() => host.shutdown());
    const fake = new FakeBackend();
    let attempts = 0;
    host.registerBackend({ name: "pi", async create(options) {
      const stateDir = options.stateDir!;
      const path = join(stateDir, "models-store.json");
      if (++attempts === 1) writeFileSync(path, '{"catalog":"safe"}');
      else if (attempts === 2) {
        if (replacement === "directory link") {
          renameSync(stateDir, stateDir + "-original");
          symlinkSync(root, stateDir, "dir");
        } else {
          unlinkSync(path);
          if (replacement === "symbolic link") symlinkSync(secret, path);
          else linkSync(secret, path);
        }
      } else assert.equal(readFileSync(path, "utf8"), '{"catalog":"safe"}');
      return fake.create(options);
    } });
    await host.models("/tmp");
    await host.models("/tmp", true);
    await host.models("/tmp", true);
    assert.equal(attempts, 3);
  });
}

it("Pi probe state remains available when disposal fails", async t => {
  const host = new SessionHost();
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  let stateDir = "";
  host.registerBackend({ name: "pi", async create(options) {
    stateDir = options.stateDir!;
    const session = await fake.create(options);
    session.dispose = async () => { throw new Error("Worker still running"); };
    return session;
  } });
  await host.models("/tmp");
  t.after(() => rmSync(join(stateDir, ".."), { recursive: true, force: true }));
  assert.equal(existsSync(stateDir), true);
});

it("builder model probes never prompt and report startup failures without an ordinary retry", async () => {
  let attempts = 0;
  const listing = await probeModels({ name: "broken", create: async options => {
    attempts++;
    assert.ok(options.workflowBuilder);
    assert.equal(options.workflowBuilder.instructions, "List available models only.");
    throw new Error("restricted startup failed");
  } }, "/tmp", true);
  assert.deepEqual(listing, { backend: "broken", models: [], problem: "restricted startup failed" });
  assert.equal(attempts, 1);
});
