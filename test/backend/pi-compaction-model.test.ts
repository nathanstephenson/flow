import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { piFixture, until, userText } from "./pi-fixture.ts";

it("Pi uses the configured model for manual and automatic compaction without switching the main model", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => ({ text: userText(request).includes("<conversation>")
    ? "## Goal\nKeep the user's request and progress." : "A normal response" }), { tools: [] });
  const session = await fixture.create({ compactionModelId: "flow-test/child" });
  await session.prompt("First request");
  await session.prompt("Second request");
  await session.compact?.("Keep goals");
  await until(() => fixture.events.some((event) => event.type === "compacted"));
  const summarizations = fixture.requests.filter((request) => userText(request).includes("<conversation>"));
  assert.ok(summarizations.length >= 1);
  assert.ok(summarizations.every((request) => request.model === "child"));
  assert.equal((session as unknown as { session: AgentSession }).session.model?.id, "parent");

  await session.prompt("Third request");
  await session.prompt("Fourth request");
  await session.prompt("Fifth request");
  const inner = (session as unknown as { session: AgentSession }).session;
  const automatic = inner as unknown as { _runAutoCompaction(reason: string, willRetry: boolean): Promise<boolean> };
  await automatic._runAutoCompaction("threshold", false);
  assert.equal(fixture.events.filter((event) => event.type === "compacted").length, 2);
  assert.ok(fixture.requests.filter((request) => userText(request).includes("<conversation>")).length > summarizations.length);
  assert.equal(fixture.requests.filter((request) => userText(request).includes("<conversation>")).at(-1)?.model, "child");
  assert.equal(inner.model?.id, "parent");
});

it("Pi cancels a failed compaction instead of falling back to the main model", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.model === "child"
    ? { error: "compaction service unavailable", status: 400 }
    : { text: "A normal response" }, { tools: [] });
  const session = await fixture.create({ compactionModelId: "flow-test/child" });
  await session.prompt("First request");
  await session.prompt("Second request");
  await session.compact?.();
  await until(() => fixture.events.some((event) => event.type === "notice" && event.text.includes("No other model was used")));
  assert.equal(fixture.requests.filter((request) => request.model === "parent").length, 2);
  assert.equal(fixture.events.some((event) => event.type === "compacted"), false);
});

it("Pi does not silently use the main model when the configured compaction model is unavailable", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "A normal response" }), { tools: [] });
  const session = await fixture.create({ compactionModelId: "flow-test/missing" });
  await session.prompt("First request");
  await session.prompt("Second request");
  await session.compact?.();
  await until(() => fixture.events.some((event) => event.type === "notice" && event.text.includes("unavailable")));
  assert.equal(fixture.requests.length, 2, "there was no compaction request on the main model");
  assert.equal(fixture.events.some((event) => event.type === "compacted"), false);
});
