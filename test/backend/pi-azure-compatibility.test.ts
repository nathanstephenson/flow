import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { findPiModel } from "../../src/backend/pi/model-selection.ts";
import { piFixture, until, userText } from "./pi-fixture.ts";

it("aliases only the Azure Provider and retains the exact model ID", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-azure-selection-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const azure = { provider: "azure", id: "gpt-5.4" };
  const other = { provider: "openai", id: "gpt-5.4" };
  const available = [other, { provider: "azure-openai-responses", id: "gpt-5.4" }, azure];
  assert.equal(findPiModel(available, "azure-openai-responses/gpt-5.4", false, agentDir), azure);
  assert.equal(findPiModel(available, "azure/gpt-5.4", false, agentDir), azure);
  assert.equal(findPiModel(available, "openai/gpt-5.4", false, agentDir), other);
  assert.equal(findPiModel(available, "azure-openai-responses/gpt-5.5", false, agentDir), undefined);
  assert.equal(findPiModel([other], "azure-openai-responses/gpt-5.4", true, agentDir), undefined);
  assert.equal(findPiModel(available, "gpt-5.4", true, agentDir), undefined);
  assert.equal(findPiModel([azure], "gpt-5.4", true, agentDir), azure);
  assert.equal(findPiModel([azure], "gpt-5.4", false, agentDir), undefined);
});

for (const filename of ["auth.json", "models.json"]) {
  it(`diagnoses legacy-only ${filename} without changing host files`, (t) => {
    const agentDir = mkdtempSync(join(tmpdir(), "flow-azure-config-"));
    t.after(() => rmSync(agentDir, { recursive: true, force: true }));
    const legacy = { "azure-openai-responses": { apiKey: "legacy-secret", baseUrl: "https://legacy.example" } };
    const config = filename === "models.json" ? { providers: legacy } : legacy;
    const path = join(agentDir, filename);
    const original = JSON.stringify(config);
    writeFileSync(path, original);
    assert.throws(() => findPiModel([{ provider: "azure", id: "gpt-5.4" }], "azure-openai-responses/gpt-5.4", false, agentDir),
      (error: Error) => error.message.includes(filename) && error.message.includes("azure-openai-responses") && error.message.includes("azure"));
    assert.equal(readFileSync(path, "utf8"), original);
    const canonical = { ...legacy, azure: { apiKey: "canonical-secret", baseUrl: "https://canonical.example" } };
    const both = JSON.stringify(filename === "models.json" ? { providers: canonical } : canonical);
    writeFileSync(path, both);
    const model = { provider: "azure", id: "gpt-5.4" };
    assert.equal(findPiModel([model], "azure-openai-responses/gpt-5.4", false, agentDir), model);
    assert.equal(readFileSync(path, "utf8"), both);
  });
}

for (const [format, prefix] of [["comments", "// Provider settings\n"], ["BOM", "\uFEFF"], ["comments and BOM", "\uFEFF// Provider settings\n"]]) {
  it(`accepts Pi models.json with ${format} and trailing commas without rewriting it`, (t) => {
    const agentDir = mkdtempSync(join(tmpdir(), "flow-azure-json-"));
    t.after(() => rmSync(agentDir, { recursive: true, force: true }));
    const path = join(agentDir, "models.json");
    const providers = { azure: { apiKey: 'key"//not a comment', baseUrl: "https://example.invalid/a//b" } };
    const original = `${prefix}{"providers":${JSON.stringify(providers)},\n}`;
    writeFileSync(path, original);
    const model = { provider: "azure", id: "gpt-5.4" };
    assert.equal(findPiModel([model], "azure-openai-responses/gpt-5.4", false, agentDir), model);
    assert.equal(readFileSync(path, "utf8"), original);
    const legacy = original.replace('"azure":', '"azure-openai-responses":');
    writeFileSync(path, legacy);
    assert.throws(() => findPiModel([model], "azure/gpt-5.4", false, agentDir), /Pi 1.6 renamed Provider/);
    assert.equal(readFileSync(path, "utf8"), legacy);
  });
}

it("accepts Pi auth.json with a BOM without rewriting it", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "flow-azure-auth-bom-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const path = join(agentDir, "auth.json");
  const original = '\uFEFF{"azure":{"type":"api_key","key":"test-only"}}';
  writeFileSync(path, original);
  const model = { provider: "azure", id: "gpt-5.4" };
  assert.equal(findPiModel([model], "azure/gpt-5.4", false, agentDir), model);
  assert.equal(readFileSync(path, "utf8"), original);
});

it("selects legacy Azure references in Agent Sessions, Subagents, workflows and compaction", { timeout: 20_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (userText(request).includes("<conversation>")) return { text: "## Goal\nKeep the request." };
    if (request.model === "child") return { text: "{}" };
    if (!request.messages.some((message) => message.role === "tool") && userText(request) === "Delegate") {
      return { tools: [{ id: "azure-child", name: "subagent", arguments: {
        description: "Review", prompt: "Review", model: "azure-openai-responses/child", run_in_background: false,
      } }] };
    }
    return { text: "Done" };
  });
  const path = join(fixture.scope, "models.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.providers.azure = config.providers["flow-test"];
  delete config.providers["flow-test"];
  writeFileSync(path, `\uFEFF// Provider settings\n${JSON.stringify(config).slice(0, -1)},\n}`);
  const session = await fixture.create({ modelId: "azure-openai-responses/parent", compactionModelId: "azure-openai-responses/child" });
  const inner = (session as unknown as { session: AgentSession }).session;
  assert.equal(inner.model?.provider, "azure");
  assert.equal(inner.model?.id, "parent");
  await session.prompt("Delegate");
  assert.ok(fixture.requests.some((request) => request.model === "child"));
  assert.ok(fixture.events.some((event) => event.type === "tool_ended" && event.callId === "azure-child" && !event.isError));
  const handle = session.startWorkflowSubagent!({ id: "azure-workflow", name: "Review", instructions: "Return JSON",
    input: {}, modelId: "azure-openai-responses/child", effort: "high", permissionMode: "auto-accept", emit: () => {} });
  assert.equal(await handle.done, "{}");
  await session.prompt("Second request");
  await session.compact?.();
  await until(() => fixture.events.some((event) => event.type === "compacted"));
  assert.ok(fixture.requests.filter((request) => userText(request).includes("<conversation>")).every((request) => request.model === "child"));
  assert.equal(inner.model?.id, "parent");
  const missing = "azure-openai-responses/removed-model-for-test";
  await assert.rejects(session.setModel!(missing), /Unknown model.*removed-model-for-test.*no replacement was used/);
  const unavailable = session.startWorkflowSubagent!({ id: "missing-azure-workflow", name: "Review", instructions: "Return JSON",
    input: {}, modelId: missing, effort: "high", permissionMode: "auto-accept", emit: () => {} });
  await assert.rejects(unavailable.done, /Unknown workflow model.*removed-model-for-test.*no replacement was used/);
  assert.equal(inner.model?.id, "parent");
});

it("preserves a legacy Azure default in Pi settings without rewriting it", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "Done" }), { tools: [] });
  const modelsPath = join(fixture.scope, "models.json");
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  models.providers.azure = models.providers["flow-test"];
  delete models.providers["flow-test"];
  writeFileSync(modelsPath, JSON.stringify(models));
  const settingsPath = join(fixture.scope, "settings.json");
  const settings = JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")),
    defaultProvider: "azure-openai-responses", defaultModel: "child" });
  writeFileSync(settingsPath, settings);
  const session = await fixture.backend.create({ scope: fixture.scope, stateDir: join(fixture.scope, "sessions"), emit: () => {} });
  t.after(() => session.dispose());
  const model = (session as unknown as { session: AgentSession }).session.model;
  assert.equal(model?.provider, "azure");
  assert.equal(model?.id, "child");
  assert.equal(readFileSync(settingsPath, "utf8"), settings);
});

it("does not replace an unavailable Azure Subagent or compaction model", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => userText(request) === "Delegate missing"
    && !request.messages.some((message) => message.role === "tool")
    ? { tools: [{ id: "missing-child", name: "subagent", arguments: { description: "Review", prompt: "Review",
      model: "azure-openai-responses/removed-model-for-test", run_in_background: false } }] }
    : { text: "Done" });
  const session = await fixture.create({ compactionModelId: "azure-openai-responses/removed-model-for-test" });
  await session.prompt("Delegate missing");
  const failure = fixture.events.find((event) => event.type === "tool_ended" && event.callId === "missing-child");
  assert.ok(failure?.type === "tool_ended" && failure.isError);
  assert.match(JSON.stringify(failure.result), /no replacement was used/);
  await session.prompt("Second request");
  const count = fixture.requests.length;
  await session.compact?.();
  await until(() => fixture.events.some((event) => event.type === "notice" && event.text.includes("No other model was used")));
  assert.equal(fixture.requests.length, count);
  assert.ok(fixture.requests.every((request) => request.model === "parent"));
  assert.equal(fixture.events.some((event) => event.type === "compacted"), false);
});
