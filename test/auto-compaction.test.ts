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

it("persists per-backend settings, merges edits, and clears defaults", (t) => {
  const { root, store } = fixture(t);
  store.update({ providers: { autoCompaction: {
    pi: { mode: "enabled", targetPercent: 80 },
    claude: { mode: "disabled" },
  } } });
  assert.deepEqual(new ConfigStore(root).view(), store.view());
  const snapshot = store.autoCompaction("pi");
  store.update({ providers: { autoCompaction: { pi: { mode: "disabled" } } } });
  assert.deepEqual(store.autoCompaction("pi"), { mode: "disabled" });
  assert.deepEqual(snapshot, { mode: "enabled", targetPercent: 80 });
  store.update({ providers: { autoCompaction: { pi: null, claude: null } } });
  assert.equal(store.autoCompaction("pi"), undefined);
  assert.equal(new ConfigStore(root).view().providers, undefined);
});

it("persists an independent compaction model and clears it without changing the threshold", (t) => {
  const { root, store } = fixture(t);
  store.update({ providers: { autoCompaction: { pi: { mode: "enabled", targetPercent: 72 } }, compactionModels: { pi: "flow-test/child" } } });
  assert.equal(new ConfigStore(root).compactionModel("pi"), "flow-test/child");
  store.update({ providers: { compactionModels: { pi: "" } } });
  assert.equal(store.compactionModel("pi"), undefined);
  assert.deepEqual(store.autoCompaction("pi"), { mode: "enabled", targetPercent: 72 });
  for (const value of [null, [], true, { pi: 4 }, { pi: " bad " }, { " pi ": "model" }, { claude: "sonnet" }]) {
    assert.throws(() => store.update({ providers: { compactionModels: value } } as unknown as SettingsPatch), /providers.compactionModels/);
  }
});

it("refuses invalid patches atomically, including old per-model patches", (t) => {
  const { root, store } = fixture(t);
  store.update({ providers: { autoCompaction: { pi: { mode: "disabled" } } } });
  const before = readFileSync(join(root, "config.json"), "utf8");
  const invalid = [
    ...[0, 100, -1, 1.5, "80", null, NaN, Infinity].map((targetPercent) => ({ mode: "enabled", targetPercent })),
    {}, [], true, "disabled", { mode: "default" }, { mode: "enabled" },
    { mode: "disabled", targetPercent: 80 }, { mode: "disabled", extra: true },
    { "p/one": { mode: "disabled" } },
  ];
  for (const value of invalid) {
    assert.throws(() => store.update({ fonts: { chrome: "Arial" }, providers: { autoCompaction: { pi: value } } } as SettingsPatch), /providers.autoCompaction/);
    assert.equal(readFileSync(join(root, "config.json"), "utf8"), before);
  }
  for (const autoCompaction of [null, [], true, { pi: [] }, { pi: "bad" }, { " pi ": { mode: "disabled" } }]) {
    assert.throws(() => store.update({ providers: { autoCompaction } } as unknown as SettingsPatch), /providers.autoCompaction/);
  }
});

it("loads modern values beside invalid values and retains unknown adapters", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ providers: { autoCompaction: {
    pi: { mode: "enabled", targetPercent: 80 }, claude: { mode: "enabled", targetPercent: 100 },
    future: { mode: "disabled" },
  } } }));
  const store = new ConfigStore(root);
  assert.match(store.warning ?? "", /providers.autoCompaction.claude/);
  assert.deepEqual(store.autoCompaction("pi"), { mode: "enabled", targetPercent: 80 });
  assert.deepEqual(store.autoCompaction("future"), { mode: "disabled" });
});

it("migrates consistent legacy entries and leaves conflicting ones at backend defaults", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "config.json"), JSON.stringify({ providers: { autoCompaction: {
    pi: { "p/one": { mode: "enabled", targetPercent: 75 }, "p/two": { mode: "enabled", targetPercent: 75 } },
    claude: { opus: { mode: "disabled" }, sonnet: { mode: "enabled", targetPercent: 80 } },
    future: { model: { mode: "disabled" } },
  } } }));
  const store = new ConfigStore(root);
  assert.deepEqual(store.autoCompaction("pi"), { mode: "enabled", targetPercent: 75 });
  assert.equal(store.autoCompaction("claude"), undefined);
  assert.deepEqual(store.autoCompaction("future"), { mode: "disabled" });
  assert.match(store.warning ?? "", /Conflicting legacy auto-compaction settings for claude/);
  store.update({ fonts: { chrome: "Arial" } });
  assert.deepEqual(new ConfigStore(root).view().providers?.autoCompaction, {
    pi: { mode: "enabled", targetPercent: 75 }, future: { mode: "disabled" },
  });
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

it("the host reads a fresh backend snapshot on open and Revive, but not on save or model change", async (t) => {
  const { store } = fixture(t);
  const host = new SessionHost({ autoCompaction: store.autoCompaction, compactionModel: () => store.compactionModel("pi") });
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  const opened: BackendCreateOptions[] = [];
  host.registerBackend({ name: "fake", create: (options) => { opened.push(options); return fake.create(options); } });
  store.update({ providers: { autoCompaction: { fake: { mode: "enabled", targetPercent: 80 } }, compactionModels: { pi: "m1" } } });
  const id = await host.create({ scope: "/tmp", backend: "fake", modelId: "m1" });
  store.update({ providers: { autoCompaction: { fake: { mode: "disabled" } }, compactionModels: { pi: "m2" } } });
  await host.setModel(id, "m2");
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0]?.autoCompaction, { mode: "enabled", targetPercent: 80 });
  assert.equal(opened[0]?.compactionModelId, "m1");
  await host.shutdown();
  await host.revive(id);
  assert.equal(opened[1]?.modelId, "m2");
  assert.deepEqual(opened[1]?.autoCompaction, { mode: "disabled" });
  assert.equal(opened[1]?.compactionModelId, "m2");
});
