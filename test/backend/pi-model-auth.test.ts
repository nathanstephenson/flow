import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createPiModelAuth, createWorkerPiModelRuntime, type PiModelAuth } from "../../src/backend/pi/model-auth.ts";
import { PiBackend } from "../../src/backend/pi/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { until } from "./pi-fixture.ts";

const providerId = "openai-codex";
const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.test`;
const expired = { type: "oauth", access: "expired-access", refresh: "original-refresh", expires: 0 };
const unrelated = { type: "oauth", access: "unrelated-access", refresh: "unrelated-refresh", expires: 0 };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "flow-pi-model-auth-"));
  const authPath = join(root, "canonical.json");
  const modelsPath = join(root, "models.json");
  writeFileSync(authPath, JSON.stringify({ [providerId]: expired, unrelated }));
  const requests: { authorization: string | undefined; providerHeader: string | string[] | undefined; modelHeader: string | string[] | undefined }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requests.push({ authorization: request.headers.authorization, providerHeader: request.headers["x-provider"], modelHeader: request.headers["x-model"] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "synthetic response" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "synthetic", choices: [choice] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const config = { providers: { [providerId]: {
    baseUrl: `${endpoint}/v1`, api: "openai-completions", apiKey: "!false",
    headers: { "X-Provider": "provider-value" },
    models: [{ id: "synthetic", contextWindow: 16384, maxTokens: 1024, headers: { "X-Model": "model-value" } }],
  } } };
  writeFileSync(modelsPath, JSON.stringify(config));
  const originalFetch = globalThis.fetch;
  let refreshes = 0;
  let refresh: (signal: AbortSignal | null | undefined) => Promise<Response> = async (signal) => {
    await sleep(30, undefined, signal ? { signal } : {});
    return Response.json({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === "https://auth.openai.com/oauth/token") {
      refreshes++;
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "original-refresh");
      return refresh(init?.signal);
    }
    assert.ok(url.startsWith(`${endpoint}/`), `Unexpected network request: ${url}`);
    return originalFetch(input, init);
  });
  const saved = { PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"], PI_OFFLINE: process.env["PI_OFFLINE"] };
  process.env["PI_CODING_AGENT_DIR"] = root;
  process.env["PI_OFFLINE"] = "1";
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, authPath, modelsPath, config, requests,
    host: () => createPiModelAuth({ authPath }),
    refreshes: () => refreshes,
    setRefresh: (fn: typeof refresh) => { refresh = fn; },
    stored: () => JSON.parse(readFileSync(authPath, "utf8")),
  };
}

test("stored API-key templates do not replace worker configuration after logout", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.config.providers[providerId].apiKey = "configured-fallback";
  writeFileSync(f.modelsPath, JSON.stringify(f.config));
  writeFileSync(f.authPath, JSON.stringify({ [providerId]: {
    type: "api_key", key: "${FLOW_BROKER_TEMPLATE}", env: { FLOW_BROKER_TEMPLATE: "synthetic-value" },
  } }));
  const runtime = await createWorkerPiModelRuntime(f.host(), f.modelsPath);
  assert.equal((await runtime.getAuth(providerId))?.auth.apiKey, "synthetic-value");
  writeFileSync(f.authPath, "{}");
  await runtime.refresh({ allowNetwork: false });
  assert.equal((await runtime.getAuth(providerId))?.auth.apiKey, "configured-fallback");
});

test("Pi host metadata reloads current configuration without resolving or refreshing auth", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const metadata = await host.snapshot();
  assert.deepEqual(metadata.find((entry) => entry.providerId === providerId)?.check, { type: "oauth", source: "OAuth" });
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(f.stored(), { [providerId]: expired, unrelated });
  assert.doesNotMatch(JSON.stringify(metadata), /original-refresh|expired-access|unrelated-access/);
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { ...f.config.providers, added: {
    baseUrl: "http://unused.invalid/v1", api: "openai-completions", apiKey: "!false", models: [{ id: "new" }],
  } } }));
  assert.ok(!(await host.snapshot()).some((entry) => entry.providerId === "added"));
  assert.equal(f.refreshes(), 0);
  await assert.rejects(host.resolve("unknown"), /Unknown Pi provider/);
  await assert.rejects(host.resolve({ provider: providerId, baseUrl: "http://unused.invalid" } as unknown as string), /Unknown Pi provider/);
});

test("Pi shares canonical refresh locks with independent SDK runtimes and retains rotated credentials", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const first = f.host();
  const summary = f.host();
  await Promise.all([first.snapshot(), summary.snapshot()]);
  const externalPi = await ModelRuntime.create({ authPath: f.authPath, modelsPath: null, refreshOnCreate: false });
  const resolutions = await Promise.all([
    first.resolve(providerId), first.resolve(providerId), summary.resolve(providerId), externalPi.getAuth(providerId),
  ]);
  for (const result of resolutions) {
    assert.equal(result?.auth.apiKey, access);
    assert.doesNotMatch(JSON.stringify(result), /refresh|unrelated|expired-access/);
  }
  assert.equal(f.refreshes(), 1);
  assert.equal(f.stored()[providerId].refresh, "rotated-refresh");
  assert.deepEqual(f.stored().unrelated, unrelated);
  const revived = f.host();
  await revived.snapshot();
  assert.equal((await revived.resolve(providerId))?.auth.apiKey, access);
  assert.equal(f.refreshes(), 1);
});

test("Pi worker streaming uses host auth despite models.json auth, preserving OAuth status and model headers", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const workerAuth = join(f.root, "auth.json");
  const poison = JSON.stringify({ [providerId]: { ...expired, access: "worker-poison", expires: Date.now() + 3600000 } });
  writeFileSync(workerAuth, poison);
  let snapshots = 0;
  const resolved: string[] = [];
  const host = f.host();
  const callbacks: PiModelAuth = {
    snapshot: (signal) => { snapshots++; return host.snapshot(signal); },
    resolve: (id, signal) => { resolved.push(id); return host.resolve(id, signal); },
  };
  const runtime = await createWorkerPiModelRuntime(callbacks, f.modelsPath);
  assert.equal(snapshots, 1);
  assert.deepEqual(resolved, []);
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(await runtime.listCredentials(), []);
  assert.equal(runtime.isUsingOAuth(providerId), true);
  assert.equal(runtime.isUsingSubscription(providerId), true);
  await runtime.refresh({ allowNetwork: true });
  assert.equal(runtime.isUsingSubscription(providerId), true);
  assert.deepEqual(resolved, []);
  const model = runtime.getModel(providerId, "synthetic");
  assert.ok(model);
  for (const complete of [runtime.complete.bind(runtime), runtime.completeSimple.bind(runtime)]) {
    const result: AssistantMessage = await complete(model, { messages: [{ role: "user", content: "test", timestamp: Date.now() }] });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "synthetic response" }]);
  }
  assert.deepEqual(resolved, [providerId, providerId]);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) assert.deepEqual(request, {
    authorization: `Bearer ${access}`, providerHeader: "provider-value", modelHeader: "model-value",
  });
  assert.equal(readFileSync(workerAuth, "utf8"), poison);
  await assert.rejects(runtime.logout(providerId), /read-only/);
  assert.equal(readFileSync(workerAuth, "utf8"), poison);
});

test('Pi model reload keeps host routing, headers and OAuth state', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const runtime = await createWorkerPiModelRuntime(f.host(), f.modelsPath);
  const provider = f.config.providers[providerId];
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { [providerId]: { ...provider,
    authHeader: true,
    models: [...provider.models, { id: 'reloaded', headers: { Authorization: 'model-authorization', 'X-Model': 'reloaded' } }],
  } } }));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.isUsingSubscription(providerId), true);
  const model = runtime.getModel(providerId, 'reloaded');
  assert.ok(model);
  const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] });
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.deepEqual(f.requests, [{ authorization: 'model-authorization', providerHeader: 'provider-value', modelHeader: 'reloaded' }]);
  assert.equal(f.refreshes(), 1);
  writeFileSync(f.authPath, '{}');
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.isUsingSubscription(providerId), false);
});

test("Pi worker discovery keeps model configuration local without requesting host auth", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const runtime = await createWorkerPiModelRuntime({
    snapshot: async () => [],
    resolve: async () => { throw new Error("Discovery must not resolve auth"); },
  }, f.modelsPath);
  assert.ok(runtime.getAvailableSnapshot().some(model => model.id === 'synthetic'));
  assert.deepEqual(await runtime.checkAuth(providerId), { type: 'api_key', source: 'configured API key' });
  assert.equal(runtime.isUsingOAuth(providerId), false);
  assert.equal(f.refreshes(), 0);
});

test('Pi retains credential-specific Copilot model filtering without exposing tokens', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const catalog = await ModelRuntime.create({ authPath: f.authPath, modelsPath: null, refreshOnCreate: false });
  const selected = catalog.getModels('github-copilot')[0]!;
  const classifiers = catalog.getModelsOfType('classifier', 'github-copilot').map(model => model.id);
  assert.ok(selected);
  assert.ok(classifiers.length);
  writeFileSync(f.authPath, JSON.stringify({ 'github-copilot': { ...expired,
    expires: Date.now() + 3600000, availableModelIds: [selected.id] } }));
  const runtime = await createWorkerPiModelRuntime(f.host(), null);
  assert.deepEqual((await runtime.getAvailable('github-copilot')).map(model => model.id), [selected.id]);
  assert.deepEqual((await runtime.getAllAvailable('github-copilot')).map(model => model.id), [selected.id, ...classifiers]);
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual((await runtime.getAvailable('github-copilot')).map(model => model.id), [selected.id]);
  writeFileSync(f.authPath, JSON.stringify({ 'github-copilot': { ...expired,
    expires: Date.now() + 3600000, availableModelIds: [] } }));
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(await runtime.getAvailable('github-copilot'), []);
  assert.deepEqual((await runtime.getAllAvailable('github-copilot')).map(model => model.id), classifiers);
  assert.equal(f.refreshes(), 0);
});

for (const key of ['synthetic-selected', '${SYNTHETIC_KEY}']) test(`Pi resolves stored API keys inside the worker: ${key}`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  writeFileSync(f.authPath, JSON.stringify({ custom: { type: 'api_key', key, env: { SYNTHETIC_KEY: 'synthetic-selected' } } }));
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { custom: { ...f.config.providers[providerId], apiKey: 'wrong-model-key' } } }));
  const runtime = await createWorkerPiModelRuntime(f.host(), f.modelsPath);
  const model = runtime.getModel('custom', 'synthetic');
  assert.ok(model);
  const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] });
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(f.requests[0]?.authorization, 'Bearer synthetic-selected');
  assert.equal(f.refreshes(), 0);
});

test("PiBackend without auth callbacks keeps ordinary SDK credential refresh", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const authPath = join(f.root, "auth.json");
  writeFileSync(authPath, JSON.stringify({ [providerId]: expired }));
  writeFileSync(join(f.root, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const session = await new PiBackend().create({ scope: f.root, tools: "none", modelId: `${providerId}/synthetic`, emit: () => {} });
  try {
    await session.prompt("synthetic prompt");
  } finally {
    await session.dispose();
  }
  assert.equal(f.refreshes(), 1);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(readFileSync(authPath, "utf8"))[providerId].refresh, "rotated-refresh");
  assert.deepEqual(f.stored()[providerId], expired);
});

test("PiBackend injects host auth and disposal does not discard canonical rotation", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const backend = new PiBackend();
  const events: BackendEvent[] = [];
  for (let i = 0; i < 2; i++) {
    const session = await backend.create({ scope: f.root, tools: "none", modelId: `${providerId}/synthetic`,
      emit: (event) => events.push(event), piAuth: f.host() });
    try {
      assert.ok(session.capabilities.models.some((model) => model.id === `${providerId}/synthetic`));
      await session.prompt("synthetic prompt");
    } finally {
      await session.dispose();
    }
  }
  assert.equal(f.refreshes(), 1);
  assert.equal(f.requests.length, 2);
  assert.ok(events.some((event) => event.type === "message" && event.final && event.text === "synthetic response"));
  assert.equal(f.stored()[providerId].refresh, "rotated-refresh");
});

test("Pi compaction uses the injected host auth", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 } }));
  const host = f.host();
  let resolutions = 0;
  const events: BackendEvent[] = [];
  const session = await new PiBackend().create({ scope: f.root, modelId: `${providerId}/synthetic`,
    compactionModelId: `${providerId}/synthetic`, emit: (event) => events.push(event), piAuth: {
      snapshot: (signal) => host.snapshot(signal),
      resolve: (id, signal) => { resolutions++; return host.resolve(id, signal); },
    } });
  try {
    await session.prompt("first prompt");
    await session.prompt("second prompt");
    await session.compact?.();
    await until(() => events.some((event) => event.type === "compacted"));
    assert.equal(resolutions, 3);
    assert.equal(f.refreshes(), 1);
    assert.ok(f.requests.length >= 3);
    assert.ok(f.requests.every((request) => request.authorization === `Bearer ${access}`));
  } finally {
    await session.dispose();
  }
});

test("Pi auth cancellation and refresh failure preserve canonical credentials", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  await host.snapshot();
  const cancelled = AbortSignal.abort();
  await assert.rejects(host.snapshot(cancelled), { name: "AbortError" });
  await assert.rejects(host.resolve(providerId, cancelled), { name: "AbortError" });
  assert.equal(f.refreshes(), 0);
  f.setRefresh(async () => Response.json({ error: "synthetic invalid_grant" }, { status: 400 }));
  await assert.rejects(host.resolve(providerId), /OAuth refresh failed/);
  assert.deepEqual(f.stored()[providerId], expired);
});
