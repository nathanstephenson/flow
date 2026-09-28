import assert from "node:assert/strict";
import { it } from "node:test";
import { SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { piAutoCompaction } from "../../src/backend/pi/auto-compaction.ts";
import { claudeAutoCompactionEnv } from "../../src/backend/claude/auto-compaction.ts";
import type { BackendSession } from "../../src/backend/types.ts";
import { piFixture } from "./pi-fixture.ts";

it("Pi recalculates one backend target for each model and falls back for unknown windows", () => {
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1234, keepRecentTokens: 5678 } });
  const apply = piAutoCompaction(settings, { mode: "enabled", targetPercent: 75 });
  apply({ contextWindow: 200_003 });
  assert.deepEqual(settings.getCompactionSettings(), { enabled: true, reserveTokens: 50_000, keepRecentTokens: 5678 });
  apply({ contextWindow: 1_000_000 });
  assert.equal(settings.getCompactionReserveTokens(), 250_000);
  for (const contextWindow of [undefined, 0, NaN, Infinity]) {
    apply(contextWindow === undefined ? {} : { contextWindow });
    assert.deepEqual(settings.getCompactionSettings(), { enabled: true, reserveTokens: 1234, keepRecentTokens: 5678 });
  }
  const disabled = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1234, keepRecentTokens: 5678 } });
  piAutoCompaction(disabled, { mode: "disabled" })({ contextWindow: 200_000 });
  assert.deepEqual(disabled.getCompactionSettings(), { enabled: false, reserveTokens: 1234, keepRecentTokens: 5678 });
  const defaults = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1234, keepRecentTokens: 5678 } });
  piAutoCompaction(defaults, undefined)({ contextWindow: 200_000 });
  assert.deepEqual(defaults.getCompactionSettings(), { enabled: true, reserveTokens: 1234, keepRecentTokens: 5678 });
});

it("Pi applies snapshots at open, model change and Revive without persisting SDK overrides", async (t) => {
  const fixture = await piFixture(t, () => ({ text: "ok" }), { tools: [] });
  const session = await fixture.create({ autoCompaction: { mode: "enabled", targetPercent: 75 } });
  const settingsOf = (value: BackendSession) => (value as unknown as { session: AgentSession }).session.settingsManager;
  assert.equal(settingsOf(session).getCompactionEnabled(), true);
  assert.equal(settingsOf(session).getCompactionReserveTokens(), 4096);
  assert.equal(session.capabilities.autoCompaction, "model-change");
  assert.equal(session.capabilities.models.find((model) => model.id === "flow-test/parent")?.contextWindow, 16384);
  await session.setModel("flow-test/child");
  assert.equal(settingsOf(session).getCompactionEnabled(), true);
  assert.equal(settingsOf(session).getCompactionReserveTokens(), 4096);
  await session.setModel("flow-test/parent");
  assert.equal(settingsOf(session).getCompactionReserveTokens(), 4096);
  await session.prompt("Persist this Conversation Context");
  const resume = session.resumeToken();
  assert.ok(resume);
  await session.dispose();
  const revived = await fixture.create({ resume, autoCompaction: { mode: "disabled" } });
  assert.equal(settingsOf(revived).getCompactionEnabled(), false);
  assert.equal(settingsOf(revived).getCompactionReserveTokens(), 16384);
  await revived.dispose();
  const reset = await fixture.create({ resume });
  assert.equal(settingsOf(reset).getCompactionEnabled(), false);
  assert.equal(settingsOf(reset).getCompactionReserveTokens(), 16384);
  assert.equal(typeof reset.compact, "function");
});

it("Claude leaves backend defaults alone and overrides conflicting inherited variables", () => {
  const inherited = { KEEP: "value", DISABLE_AUTO_COMPACT: "1", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "20" };
  assert.equal(claudeAutoCompactionEnv(undefined, inherited), undefined);
  assert.deepEqual(claudeAutoCompactionEnv({ mode: "enabled", targetPercent: 80 }, inherited), {
    KEEP: "value", DISABLE_AUTO_COMPACT: "0", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
  });
  assert.deepEqual(claudeAutoCompactionEnv({ mode: "disabled" }, inherited), { KEEP: "value", DISABLE_AUTO_COMPACT: "1" });
  assert.deepEqual(inherited, { KEEP: "value", DISABLE_AUTO_COMPACT: "1", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "20" });
});
