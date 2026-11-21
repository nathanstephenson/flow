import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { createPiModelAuth } from "../../src/backend/pi/host-auth.ts";

const providerId = "openai-codex";
const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.test`;
const expired = { type: "oauth", access: "expired-access", refresh: "original-refresh", expires: 0 };
const unrelated = { type: "oauth", access: "unrelated-access", refresh: "unrelated-refresh", expires: 0 };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "flow-pi-host-auth-"));
  const authPath = join(root, "auth.json");
  const write = (raw: unknown) => writeFileSync(authPath, JSON.stringify(raw));
  write({ [providerId]: expired, unrelated });
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = root;
  t.after(() => {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  let refreshes = 0;
  let refresh = async () => {
    await sleep(20);
    return Response.json({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), "https://auth.openai.com/oauth/token", "Unexpected network request");
    assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "original-refresh");
    refreshes++;
    return refresh();
  });
  return {
    root, authPath, write,
    host: () => createPiModelAuth({ authPath }),
    stored: () => JSON.parse(readFileSync(authPath, "utf8")),
    refreshes: () => refreshes,
    setRefresh: (fn: typeof refresh) => { refresh = fn; },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Pi host metadata reads only stored metadata and executes no auth or model commands", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const authMarker = join(f.root, "auth-command-ran");
  const modelMarker = join(f.root, "model-command-ran");
  f.write({ [providerId]: expired, command: { type: "api_key", key: `!touch ${authMarker}` }, unrelated });
  writeFileSync(join(f.root, "models.json"), JSON.stringify({ providers: { custom: {
    apiKey: `!touch ${modelMarker}`, api: "openai-completions", baseUrl: "https://unused.invalid/v1", models: [{ id: "synthetic" }],
  } } }));
  const host = f.host();
  assert.deepEqual(await host.snapshot(), [
    { providerId, check: { type: "oauth", source: "OAuth" } },
    { providerId: "command", check: { type: "api_key", source: "stored credential" } },
    { providerId: "unrelated", check: { type: "oauth", source: "OAuth" } },
  ]);
  assert.equal(f.refreshes(), 0);
  assert.equal(existsSync(authMarker), false);
  assert.equal(existsSync(modelMarker), false);
  assert.deepEqual(f.stored()[providerId], expired);
  await assert.rejects(host.resolve("command"), /auth.json.*models.json.*worker/);
  assert.equal(existsSync(authMarker), false);
  assert.equal(existsSync(modelMarker), false);
  f.write({ added: { type: "api_key", key: "new-key" } });
  assert.deepEqual((await host.snapshot()).map((entry) => entry.providerId), ["added"]);
});

test("Pi host accepts Pi model configuration syntax without executing commands or rewriting files", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "model-command-ran");
  const modelsPath = join(f.root, "models.json");
  const models = `\uFEFF{
    // Pi model configuration
    "providers": {
      "corporate": {
        "oauth": "radius",
        "baseUrl": "https://gateway.invalid/v1", // Preserve URL slashes
        "apiKey": "!touch ${marker}",
      },
    },
  }`;
  writeFileSync(modelsPath, models);
  f.write({ corporate: { type: "api_key", key: "stored-key" } });
  const authBefore = readFileSync(f.authPath, "utf8");
  const host = f.host();
  assert.deepEqual(await host.snapshot(), [{
    providerId: "corporate", check: { type: "api_key", source: "stored credential" }, radiusGateway: "https://gateway.invalid",
  }]);
  assert.deepEqual(await host.resolve("corporate"), { auth: { apiKey: "stored-key" }, source: "stored credential" });
  assert.equal(readFileSync(modelsPath, "utf8"), models);
  assert.equal(readFileSync(f.authPath, "utf8"), authBefore);
  assert.equal(existsSync(marker), false);
  assert.equal(f.refreshes(), 0);
});

test("Pi host returns only the selected raw key and env without expansion", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.write({ selected: { type: "api_key", key: "${DO_NOT_EXPAND}", env: { SYNTHETIC: "raw-value" }, private: "hidden-extra" }, unrelated });
  const host = f.host();
  assert.deepEqual(await host.resolve("selected"), {
    auth: { apiKey: "${DO_NOT_EXPAND}" }, env: { SYNTHETIC: "raw-value" }, source: "stored credential",
  });
  assert.equal(f.refreshes(), 0);
  await assert.rejects(host.resolve("../auth.json"), /Unknown Pi provider/);
  await assert.rejects(host.resolve("toString"), /Unknown Pi provider/);
  await assert.rejects(host.resolve({ providerId } as unknown as string), /Unknown Pi provider/);
});

test("Pi host Copilot metadata accepts only string model ids and has no credentials", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const host = f.host();
  f.write({ "github-copilot": { ...unrelated, availableModelIds: ["allowed-model"], unknown: { secret: "hidden" } } });
  assert.deepEqual(await host.snapshot(), [{ providerId: "github-copilot", check: { type: "oauth", source: "OAuth" }, availableModelIds: ["allowed-model"] }]);
  for (const ids of [["allowed-model", 2], "allowed-model", { id: "allowed-model" }, null]) {
    f.write({ "github-copilot": { ...unrelated, availableModelIds: ids } });
    assert.deepEqual(await host.snapshot(), [{ providerId: "github-copilot", check: { type: "oauth", source: "OAuth" } }]);
  }
  assert.equal(f.refreshes(), 0);
});

test("Pi host shares canonical locks with independent SDK refresh and preserves file mode", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  chmodSync(f.authPath, 0o640);
  const first = f.host();
  const second = f.host();
  const external = await ModelRuntime.create({ authPath: f.authPath, modelsPath: null, refreshOnCreate: false });
  const results = await Promise.all([first.resolve(providerId), first.resolve(providerId), second.resolve(providerId), external.getAuth(providerId)]);
  for (const result of results) {
    assert.equal(result?.auth.apiKey, access);
    assert.doesNotMatch(JSON.stringify(result), /refresh|unrelated|expired-access/);
  }
  assert.equal(f.refreshes(), 1);
  assert.equal(f.stored()[providerId].refresh, "rotated-refresh");
  assert.deepEqual(f.stored().unrelated, unrelated);
  assert.equal(statSync(f.authPath).mode & 0o777, 0o640);
  assert.equal((await first.resolve(providerId))?.auth.apiKey, access);
  assert.equal((await f.host().resolve(providerId))?.auth.apiKey, access);
  assert.equal(f.refreshes(), 1);
  assert.equal(existsSync(`${f.authPath}.lock`), false);
});

test("Pi host cancellation stops waiting but cannot discard a successful token rotation", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const rotated = deferred();
  const persist = deferred();
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    assert.ok(options?.credentials);
    const store = options.credentials;
    const modify = store.modify.bind(store);
    t.mock.method(store, "modify", (id: string, fn: Parameters<CredentialStore["modify"]>[1], options?: { signal?: AbortSignal }) =>
      modify(id, async (current) => {
        const next = await fn(current);
        rotated.resolve();
        await persist.promise;
        return next;
      }, options));
    return originalCreate(options);
  });
  const controller = new AbortController();
  const host = f.host();
  const result = host.resolve(providerId, controller.signal);
  try {
    await rotated.promise;
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(f.stored()[providerId], expired);
    assert.equal(existsSync(`${f.authPath}.lock`), true);
  } finally { persist.resolve(); }
  assert.equal((await host.resolve(providerId))?.auth.apiKey, access);
  assert.equal(f.stored()[providerId].refresh, "rotated-refresh");
  assert.deepEqual(f.stored().unrelated, unrelated);
  assert.equal(f.refreshes(), 1);
});

test("Pi host close drains rotation after its waiter cancels and refuses new work", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const rotated = deferred();
  const persist = deferred();
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    assert.ok(options?.credentials);
    const store = options.credentials;
    const modify = store.modify.bind(store);
    t.mock.method(store, "modify", (id: string, fn: Parameters<CredentialStore["modify"]>[1], options?: { signal?: AbortSignal }) =>
      modify(id, async (current) => {
        const next = await fn(current);
        rotated.resolve();
        await persist.promise;
        return next;
      }, options));
    return originalCreate(options);
  });
  const host = f.host();
  const controller = new AbortController();
  const result = host.resolve(providerId, controller.signal);
  let closed = false;
  try {
    await rotated.promise;
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.ok(host.close);
    const closing = host.close();
    void closing.then(() => { closed = true; });
    assert.equal(host.close(), closing);
    await assert.rejects(host.resolve(providerId), /closed/i);
    await assert.rejects(host.snapshot(), /closed/i);
    await sleep(20);
    assert.equal(closed, false);
    assert.deepEqual(f.stored()[providerId], expired);
    persist.resolve();
    await closing;
    assert.equal(closed, true);
    assert.equal(host.close(), closing);
    assert.equal(f.stored()[providerId].refresh, "rotated-refresh");
    assert.deepEqual(f.stored().unrelated, unrelated);
    assert.equal(f.refreshes(), 1);
    assert.equal(existsSync(`${f.authPath}.lock`), false);
    await assert.rejects(host.resolve(providerId), /closed/i);
    await assert.rejects(host.snapshot(), /closed/i);
    assert.equal(f.refreshes(), 1);
  } finally { persist.resolve(); }
});

test("Pi host close includes resolves admitted before an OAuth operation exists", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const creating = deferred();
  const start = deferred();
  const refreshing = deferred();
  const finish = deferred();
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    creating.resolve();
    await start.promise;
    return originalCreate(options);
  });
  f.setRefresh(async () => {
    refreshing.resolve();
    await finish.promise;
    return Response.json({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 });
  });
  const host = f.host();
  const result = host.resolve(providerId);
  try {
    assert.ok(host.close);
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await creating.promise;
    await sleep(20);
    assert.equal(closed, false);
    start.resolve();
    await refreshing.promise;
    await sleep(20);
    assert.equal(closed, false);
    finish.resolve();
    assert.equal((await result)?.auth.apiKey, access);
    await closing;
    assert.equal(f.stored()[providerId].refresh, "rotated-refresh");
    assert.equal(f.refreshes(), 1);
  } finally { start.resolve(); finish.resolve(); await result.catch(() => {}); }
});

test("Pi host close settles failed refreshes after their waiters cancel", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const refreshing = deferred();
  const finish = deferred();
  f.setRefresh(async () => {
    refreshing.resolve();
    await finish.promise;
    return Response.json({ error: "synthetic invalid_grant" }, { status: 400 });
  });
  const host = f.host();
  const controller = new AbortController();
  const result = host.resolve(providerId, controller.signal);
  try {
    await refreshing.promise;
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.ok(host.close);
    const closing = host.close();
    finish.resolve();
    await closing;
    assert.deepEqual(f.stored()[providerId], expired);
    assert.equal(existsSync(`${f.authPath}.lock`), false);
  } finally { finish.resolve(); }
});

test("Pi host refuses compromised-lock writes", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const refreshing = deferred();
  const finish = deferred();
  let compromise: ((error: Error) => void) | undefined;
  const originalLock = lockfile.lock.bind(lockfile);
  t.mock.method(lockfile, "lock", async (path: string, options: lockfile.LockOptions) => {
    compromise = options.onCompromised;
    return originalLock(path, options);
  });
  f.setRefresh(async () => {
    refreshing.resolve();
    await finish.promise;
    return Response.json({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 });
  });
  const result = f.host().resolve(providerId);
  await refreshing.promise;
  assert.ok(compromise);
  compromise(new Error("Synthetic compromised lock"));
  finish.resolve();
  await assert.rejects(result, /Credential store modify failed/);
  assert.deepEqual(f.stored(), { [providerId]: expired, unrelated });
});

test("Pi host SDK storage exposes only OAuth, lists metadata, and refuses deletion", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.write({ [providerId]: { ...expired, access, expires: Date.now() + 3600000 }, key: { type: "api_key", key: "!false" }, unrelated });
  let store: CredentialStore | undefined;
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  t.mock.method(ModelRuntime, "create", (options: Parameters<typeof ModelRuntime.create>[0]) => {
    store = options?.credentials;
    assert.equal(options?.modelsPath, null);
    assert.equal(options?.refreshOnCreate, false);
    assert.equal(options?.signal, undefined);
    return originalCreate(options);
  });
  await f.host().resolve(providerId);
  assert.ok(store);
  assert.equal(await store.read("key"), undefined);
  assert.equal(await store.read("missing"), undefined);
  assert.deepEqual(await store.list(), [{ providerId, type: "oauth" }, { providerId: "key", type: "api_key" }, { providerId: "unrelated", type: "oauth" }]);
  await assert.rejects(store.delete(providerId), /deletion is not supported/);
  await assert.rejects(store.modify(providerId, async () => ({ type: "api_key", key: "replacement" })), /only persist OAuth/);
  assert.equal(f.stored()[providerId].refresh, "original-refresh");
  assert.equal(f.refreshes(), 0);
});

test("Pi host does not create missing auth files or directories", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const authPath = join(f.root, "missing", "auth.json");
  const host = createPiModelAuth({ authPath });
  assert.deepEqual(await host.snapshot(), []);
  await assert.rejects(host.resolve(providerId), /Unknown Pi provider/);
  assert.equal(existsSync(join(f.root, "missing")), false);
  assert.equal(f.refreshes(), 0);
});

test("Pi host refuses symlink and nonregular auth sources", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const link = join(f.root, "linked.json");
  symlinkSync(f.authPath, link);
  const directory = join(f.root, "directory.json");
  mkdirSync(directory);
  for (const authPath of [link, directory]) {
    const host = createPiModelAuth({ authPath });
    await assert.rejects(host.snapshot(), /regular file/);
    await assert.rejects(host.resolve(providerId), /regular file/);
    assert.equal(existsSync(`${authPath}.lock`), false);
  }
  assert.equal(f.refreshes(), 0);
});

test("Pi host refuses unknown OAuth providers and pre-cancelled operations without refresh", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const host = f.host();
  const signal = AbortSignal.abort();
  await assert.rejects(host.snapshot(signal), { name: "AbortError" });
  await assert.rejects(host.resolve(providerId, signal), { name: "AbortError" });
  await assert.rejects(host.resolve("unrelated"), /native OAuth/);
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(f.stored()[providerId], expired);
});

test("Pi host cancellation while waiting for the canonical lock starts no refresh", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const release = await lockfile.lock(f.authPath, { realpath: false, stale: 30000 });
  try {
    await assert.rejects(f.host().resolve(providerId, AbortSignal.timeout(25)), { name: "AbortError" });
    assert.equal(f.refreshes(), 0);
    assert.deepEqual(f.stored()[providerId], expired);
  } finally { await release(); }
});

test("Pi host missing OAuth cannot fall back to an ambient API key", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.write({ anthropic: expired });
  const previous = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "ambient-key-must-not-leave-host";
  t.after(() => {
    if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = previous;
  });
  const originalCreate = ModelRuntime.create.bind(ModelRuntime);
  t.mock.method(ModelRuntime, "create", (options: Parameters<typeof ModelRuntime.create>[0]) => {
    f.write({});
    return originalCreate(options);
  });
  assert.equal(await f.host().resolve("anthropic"), undefined);
  assert.equal(f.refreshes(), 0);
});

test("Pi host invalid JSON errors do not disclose file contents", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(f.authPath, '{"private-secret":invalid}');
  await assert.rejects(f.host().snapshot(), (error: Error) => {
    assert.match(error.message, /Invalid Pi auth.json/);
    assert.doesNotMatch(error.message, /private-secret/);
    return true;
  });
});

test("Pi host refresh failure preserves canonical credentials", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.setRefresh(async () => Response.json({ error: "synthetic invalid_grant" }, { status: 400 }));
  await assert.rejects(f.host().resolve(providerId), /OAuth refresh failed/);
  assert.deepEqual(f.stored(), { [providerId]: expired, unrelated });
  assert.equal(existsSync(`${f.authPath}.lock`), false);
});
