import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ConfigStore } from "../src/daemon/config-store.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { probeModels } from "../src/daemon/models.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { BackendCreateOptions } from "../src/backend/types.ts";
import type { SettingsPatch } from "../src/protocol/settings.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "flow-auto-compaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new ConfigStore(root) };
}

it("persists per-backend and per-model settings, merges edits, and clears defaults", (t) => {
  const { root, store } = fixture(t);
  store.update({ providers: { autoCompaction: {
    pi: { "p/one": { mode: "enabled", targetPercent: 1 }, "p/two": { mode: "disabled" } },
    claude: { opus: { mode: "enabled", targetPercent: 99 } },
  } } });
  assert.deepEqual(new ConfigStore(root).view(), store.view());
  const snapshot = store.autoCompaction("pi");
  store.update({ providers: { autoCompaction: { pi: { "p/one": null } } } });
  assert.deepEqual(store.autoCompaction("pi"), { "p/two": { mode: "disabled" } });
  assert.deepEqual(snapshot["p/one"], { mode: "enabled", targetPercent: 1 });
  snapshot["p/two"] = { mode: "enabled", targetPercent: 50 };
  assert.deepEqual(store.autoCompaction("pi")["p/two"], { mode: "disabled" });
  store.update({ providers: { autoCompaction: { pi: { "p/two": null }, claude: { opus: null } } } });
  assert.equal(new ConfigStore(root).view().providers, undefined);
});

it("refuses invalid patches atomically", (t) => {
  const { root, store } = fixture(t);
  store.update({ providers: { autoCompaction: { pi: { one: { mode: "disabled" } } } } });
  const before = readFileSync(join(root, "config.json"), "utf8");
  const invalid = [
    ...[0, 100, -1, 1.5, "80", null, NaN, Infinity].map((targetPercent) => ({ mode: "enabled", targetPercent })),
    {}, [], true, "disabled", { mode: "default" }, { mode: "enabled" },
    { mode: "disabled", targetPercent: 80 }, { mode: "disabled", extra: true },
  ];
  for (const value of invalid) {
    assert.throws(() => store.update({ fonts: { chrome: "Arial" }, providers: { autoCompaction: { pi: { one: value } } } } as SettingsPatch), /providers.autoCompaction/);
    assert.equal(readFileSync(join(root, "config.json"), "utf8"), before);
  }
  for (const autoCompaction of [null, [], true, { pi: null }, { pi: [] }, { pi: "bad" }, { " pi ": { model: { mode: "disabled" } } }, { pi: { " p/model ": { mode: "disabled" } } }]) {
    assert.throws(() => store.update({ providers: { autoCompaction } } as unknown as SettingsPatch), /providers.autoCompaction/);
  }
});

it("loads valid entries beside invalid entries and retains unknown adapters", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ providers: { autoCompaction: {
    pi: { good: { mode: "enabled", targetPercent: 80 }, bad: { mode: "enabled", targetPercent: 100 } },
    future: { model: { mode: "disabled" } },
  } } }));
  const store = new ConfigStore(root);
  assert.match(store.warning ?? "", /providers.autoCompaction.pi.bad/);
  assert.deepEqual(store.autoCompaction("pi"), { good: { mode: "enabled", targetPercent: 80 } });
  assert.deepEqual(store.autoCompaction("future"), { model: { mode: "disabled" } });
});

it("model catalogues report auto settings independently of manual compaction", async () => {
  const fake = new FakeBackend({ compaction: false });
  const listing = await probeModels({ name: "test", async create(options) {
    const session = await fake.create(options);
    session.capabilities.autoCompaction = "startup";
    return session;
  } }, "/tmp");
  assert.equal(listing.autoCompaction, "startup");
  assert.ok(listing.models.length);
  assert.equal(fake.latest.capabilities.compaction, false);
});

it("the host reads a fresh snapshot on open and Revive, but not on save or model change", async (t) => {
  const { store } = fixture(t);
  const host = new SessionHost({ autoCompaction: store.autoCompaction });
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  const opened: BackendCreateOptions[] = [];
  host.registerBackend({ name: "fake", create: (options) => { opened.push(options); return fake.create(options); } });
  store.update({ providers: { autoCompaction: { fake: { m1: { mode: "enabled", targetPercent: 80 } } } } });
  const id = await host.create({ scope: "/tmp", backend: "fake", modelId: "m1" });
  store.update({ providers: { autoCompaction: { fake: { m1: { mode: "disabled" } } } } });
  await host.setModel(id, "m2");
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0]?.autoCompaction, { m1: { mode: "enabled", targetPercent: 80 } });
  await host.shutdown();
  await host.revive(id);
  assert.equal(opened[1]?.modelId, "m2");
  assert.deepEqual(opened[1]?.autoCompaction, { m1: { mode: "disabled" } });
});
