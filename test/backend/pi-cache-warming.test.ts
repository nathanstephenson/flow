import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { gate, piFixture, until } from "./pi-fixture.ts";

const decision = { type: "cache_warming_decision", action: "warm", warmCost: 0, missCost: 1, continuationProbability: 1 } as const;
const inner = (session: unknown) => (session as { session: AgentSession }).session;

it("Pi keeps default cache warming limited to active runs without changing user settings", { timeout: 15_000 }, async (t) => {
  const hold = gate();
  t.after(() => hold.release());
  const fixture = await piFixture(t, async () => { await hold.promise; return { text: "Done" }; }, { tools: [] });
  const settingsPath = join(fixture.scope, "settings.json");
  const originalSettings = readFileSync(settingsPath, "utf8");
  const session = await fixture.create();
  const runner = inner(session).extensionRunner;
  assert.equal(await runner.emitCacheWarmingDecision(decision), "stop");

  const prompt = session.prompt("Work");
  try {
    await until(() => fixture.requests.length > 0);
    assert.equal(await runner.emitCacheWarmingDecision(decision), "warm");
  } finally { hold.release(); await prompt; }

  assert.equal(await runner.emitCacheWarmingDecision(decision), "stop");
  assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
});

it("Pi preserves explicit idle cache warming", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "Done" }), { tools: [] });
  const settingsPath = join(fixture.scope, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, cacheWarming: "idle" }));
  const session = await fixture.create();
  assert.equal(await inner(session).extensionRunner.emitCacheWarmingDecision(decision), "warm");
});
