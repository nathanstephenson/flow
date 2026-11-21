import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiModelAuth, createWorkerPiModelRuntime, type PiModelAuth } from '../../src/backend/pi/model-auth.ts';

const cachedModel = {
  id: 'synthetic-custom-model', name: 'Cached model', reasoning: false, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048,
};
const access = 'synthetic-custom-access';
const refreshToken = 'synthetic-custom-refresh';

function fixture(t: TestContext, id: string) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pi-custom-radius-'));
  const authPath = join(root, 'auth.json');
  const modelsPath = join(root, 'models.json');
  const workerRoot = join(root, 'worker');
  mkdirSync(workerRoot);
  const workerModels = join(workerRoot, 'models.json');
  const marker = join(root, 'command-ran');
  let gateway = 'https://custom-one.invalid';
  const configure = (next = gateway) => {
    gateway = next;
    writeFileSync(modelsPath, JSON.stringify({ providers: { [id]: {
      oauth: 'radius', baseUrl: `${gateway}/v1`, name: 'Operator Radius',
      apiKey: `!touch ${marker}`, headers: { 'X-Secret': `!touch ${marker}` },
    } } }));
    writeFileSync(workerModels, JSON.stringify({ providers: { [id]: {
      oauth: 'radius', baseUrl: `${gateway}/v1`, name: 'Worker Radius', apiKey: 'ignored-worker-key',
      headers: { 'X-Worker': 'worker-header' }, authHeader: true,
      modelOverrides: { [cachedModel.id]: { name: 'Worker override', maxTokens: 4096 } },
    } } }));
  };
  const expire = () => writeFileSync(authPath, JSON.stringify({ [id]: {
    type: 'oauth', access: 'synthetic-expired-access', refresh: refreshToken, expires: 0,
    gatewayConfig: { baseUrl: `${gateway}/v1`, models: [cachedModel] },
  } }));
  configure();
  expire();
  const requests: string[] = [];
  let beforeRefresh: (() => void) | undefined;
  const resolutions: unknown[] = [];
  const registrations: string[] = [];
  const register = ModelRuntime.prototype.registerNativeProvider;
  t.mock.method(ModelRuntime.prototype, 'registerNativeProvider', function (this: ModelRuntime, provider: Parameters<typeof register>[0]) {
    if (provider.id === id) registrations.push(provider.id);
    return register.call(this, provider);
  });
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === `${gateway}/v1/oauth/token`) {
      beforeRefresh?.();
      assert.equal(init?.method, 'POST');
      assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token');
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), refreshToken);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return Response.json({ access_token: access, refresh_token: 'synthetic-rotated-refresh', expires_in: 3600 });
    }
    assert.equal(url, `${gateway}/v1/config`, `Unexpected network request: ${url}`);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${access}`);
    assert.doesNotMatch(JSON.stringify(init), /synthetic-custom-refresh|synthetic-rotated-refresh/);
    return Response.json({ baseUrl: `${gateway}/v1`, models: [
      { ...cachedModel, contextWindow: 64000 }, { ...cachedModel, id: 'synthetic-fresh-model' },
    ] });
  });
  const savedKey = process.env['RADIUS_API_KEY'];
  process.env['RADIUS_API_KEY'] = 'ambient-key-must-not-replace-oauth';
  t.after(() => {
    if (savedKey === undefined) delete process.env['RADIUS_API_KEY'];
    else process.env['RADIUS_API_KEY'] = savedKey;
    rmSync(root, { recursive: true, force: true });
  });
  const host = createPiModelAuth({ authPath });
  const auth: PiModelAuth = {
    snapshot: signal => host.snapshot(signal),
    async resolve(providerId, signal) {
      const result = await host.resolve(providerId, signal);
      resolutions.push(result);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-custom-refresh|synthetic-rotated-refresh|X-Secret/);
      return result;
    },
  };
  return { root, authPath, modelsPath, workerModels, marker, requests, resolutions, registrations,
    host, auth, configure, expire, gateway: () => gateway, beforeRefresh: (fn: () => void) => { beforeRefresh = fn; } };
}

for (const id of ['custom-radius', 'radius']) {
  test(`Pi native Radius ${id} restores offline models and uses only the canonical custom gateway`, { timeout: 10000 }, async t => {
    const f = fixture(t, id);
    const before = readFileSync(f.authPath, 'utf8');
    const snapshot = await f.host.snapshot();
    assert.equal(snapshot[0]?.radiusGateway, f.gateway());
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-expired-access|synthetic-custom-refresh|X-Secret|touch/);
    assert.deepEqual(f.registrations, []);
    assert.deepEqual(f.requests, []);
    assert.equal(existsSync(f.marker), false);
    const runtime = await createWorkerPiModelRuntime(f.auth, f.workerModels);
    assert.deepEqual(f.registrations, [id]);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.resolutions, []);
    assert.equal(readFileSync(f.authPath, 'utf8'), before);
    assert.ok(runtime.getAvailableSnapshot().some(model => model.provider === id && model.id === cachedModel.id));
    assert.equal(runtime.getModel(id, cachedModel.id)?.name, 'Worker override');
    assert.equal(runtime.getModel(id, cachedModel.id)?.baseUrl, `${f.gateway()}/v1`);
    assert.equal(runtime.isUsingOAuth(id), true);
    assert.deepEqual(await runtime.listCredentials(), []);
    const model = runtime.getModel(id, cachedModel.id)!;
    const result = await runtime.getAuth(model);
    assert.equal(result?.auth.apiKey, access);
    assert.equal(result?.auth.headers?.['X-Worker'], 'worker-header');
    assert.equal(result?.auth.headers?.['Authorization'], `Bearer ${access}`);
    assert.deepEqual(f.requests, [`${f.gateway()}/v1/oauth/token`]);
    assert.deepEqual(f.registrations, [id, id]);
    assert.equal(JSON.parse(readFileSync(f.authPath, 'utf8'))[id].refresh, 'synthetic-rotated-refresh');
    await runtime.getAuth(model);
    assert.deepEqual(f.registrations, [id, id]);
    assert.equal(f.requests.length, 1);
    const refreshed = await runtime.refresh({ allowNetwork: true, providers: [id] });
    assert.deepEqual([...refreshed.errors], []);
    assert.deepEqual(f.requests, [`${f.gateway()}/v1/oauth/token`, `${f.gateway()}/v1/config`]);
    assert.equal(runtime.getModel(id, cachedModel.id)?.contextWindow, 64000);
    assert.equal(runtime.getModel(id, cachedModel.id)?.maxTokens, 4096);
    assert.equal(runtime.getModel(id, 'synthetic-fresh-model')?.baseUrl, `${f.gateway()}/v1`);
    assert.deepEqual(f.registrations, [id, id]);
    assert.equal(existsSync(f.marker), false);
    assert.equal(existsSync(join(f.root, 'worker', 'auth.json')), false);
    assert.doesNotMatch(readFileSync(join(f.root, 'worker', 'models-store.json'), 'utf8'), /synthetic-custom-access|synthetic-custom-refresh|synthetic-rotated-refresh/);
    f.configure('https://custom-two.invalid');
    f.expire();
    const reloaded = await runtime.refresh({ allowNetwork: true, providers: [id] });
    assert.deepEqual([...reloaded.errors], []);
    assert.deepEqual(f.requests.slice(2), [`${f.gateway()}/v1/oauth/token`, `${f.gateway()}/v1/config`]);
    assert.deepEqual(f.registrations, [id, id, id, id]);
    assert.equal(runtime.getModel(id, 'synthetic-fresh-model')?.baseUrl, `${f.gateway()}/v1`);
    assert.equal(runtime.getModel(id, cachedModel.id)?.name, 'Worker override');
    await runtime.refresh({ allowNetwork: false, providers: [id] });
    assert.deepEqual(f.registrations, [id, id, id, id]);
    assert.equal(f.requests.length, 4);
    assert.equal(existsSync(f.marker), false);
  });
}

for (const id of ['custom-radius', 'radius']) test(`Pi preserves the legacy ${id} account catalog across token rotation and offline Revive`, { timeout: 10000 }, async t => {
  const f = fixture(t, id);
  const before = readFileSync(f.authPath, 'utf8');
  const runtime = await createWorkerPiModelRuntime(f.auth, f.workerModels);
  const cachePath = join(f.root, 'worker', 'models-store.json');
  assert.deepEqual(runtime.getModels(id).map(model => model.id), [cachedModel.id]);
  assert.equal(readFileSync(f.authPath, 'utf8'), before);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8'))[id].models.map((model: { id: string }) => model.id), [cachedModel.id]);
  assert.doesNotMatch(readFileSync(cachePath, 'utf8'), /synthetic-expired-access|synthetic-custom-refresh|X-Secret|touch/);
  const canonicalCache = join(f.root, 'models-store.json');
  f.beforeRefresh(() => {
    assert.deepEqual(JSON.parse(readFileSync(canonicalCache, 'utf8'))[id].models.map((model: { id: string }) => model.id), [cachedModel.id]);
    assert.doesNotMatch(readFileSync(canonicalCache, 'utf8'), /synthetic-expired-access|synthetic-custom-refresh|X-Secret|touch/);
  });
  assert.equal((await runtime.getAuth(id))?.auth.apiKey, access);
  const rotated = JSON.parse(readFileSync(f.authPath, 'utf8'))[id];
  assert.equal(rotated.refresh, 'synthetic-rotated-refresh');
  assert.equal(rotated.gatewayConfig, undefined);
  assert.deepEqual([...(await runtime.refresh({ allowNetwork: false })).errors], []);
  const revived = await createWorkerPiModelRuntime(f.auth, f.workerModels);
  const restarted = createPiModelAuth({ authPath: f.authPath });
  const fresh = [];
  for (const [i, auth] of [f.auth, restarted].entries()) {
    const state = join(f.root, `fresh-${i}`);
    mkdirSync(state);
    const models = join(state, 'models.json');
    writeFileSync(models, readFileSync(f.workerModels));
    fresh.push(await createWorkerPiModelRuntime(auth, models));
  }
  for (const current of [runtime, revived, ...fresh]) {
    assert.deepEqual(current.getModels(id).map(model => model.id), [cachedModel.id]);
    assert.deepEqual((await current.getAvailable(id)).map(model => model.id), [cachedModel.id]);
    assert.equal(current.getModel(id, cachedModel.id)?.name, 'Worker override');
    assert.equal(current.getModel(id, cachedModel.id)?.maxTokens, 4096);
  }
  assert.deepEqual(f.requests, [`${f.gateway()}/v1/oauth/token`]);
  assert.equal(f.resolutions.length, 1);
  assert.equal(existsSync(f.marker), false);
  assert.equal(existsSync(join(f.root, 'worker', 'auth.json')), false);
  assert.doesNotMatch(readFileSync(cachePath, 'utf8'), /synthetic-custom-access|synthetic-custom-refresh|synthetic-rotated-refresh/);
  assert.doesNotMatch(readFileSync(canonicalCache, 'utf8'), /synthetic-custom-access|synthetic-custom-refresh|synthetic-rotated-refresh/);
  await restarted.close?.();
});

test('Pi native Radius metadata normalizes only native gateway configuration without resolving commands', async t => {
  const f = fixture(t, 'alias');
  writeFileSync(f.modelsPath, JSON.stringify({ providers: {
    alias: { oauth: 'radius', baseUrl: 'gateway.invalid/v1/' },
    radius: { oauth: 'radius', baseUrl: 'https://radius.pi.dev/v1' },
    other: { oauth: 'not-radius', baseUrl: 'https://other.invalid/v1', apiKey: `!touch ${f.marker}` },
  } }));
  const snapshot = await f.host.snapshot();
  assert.equal(snapshot.find(entry => entry.providerId === 'alias')?.radiusGateway, 'https://gateway.invalid');
  assert.equal(snapshot.find(entry => entry.providerId === 'radius'), undefined);
  assert.equal(snapshot.find(entry => entry.providerId === 'other'), undefined);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.registrations, []);
  assert.equal(existsSync(f.marker), false);
});

test('Pi explicitly configured default Radius keeps cached models without extra gateway metadata', { timeout: 10000 }, async t => {
  const f = fixture(t, 'radius');
  const config = JSON.stringify({ providers: { radius: { oauth: 'radius', baseUrl: 'https://radius.pi.dev/v1' } } });
  writeFileSync(f.modelsPath, config);
  writeFileSync(f.workerModels, config);
  assert.equal((await f.host.snapshot())[0]?.radiusGateway, undefined);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.workerModels);
  assert.ok(runtime.getAvailableSnapshot().some(model => model.id === cachedModel.id));
  assert.equal(runtime.getModel('radius', cachedModel.id)?.name, cachedModel.name);
  await runtime.refresh({ allowNetwork: false });
  assert.ok(runtime.getModel('radius', cachedModel.id));
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
});

test('Pi rejects unsafe canonical Radius gateways without disclosing configuration', async t => {
  const f = fixture(t, 'alias');
  for (const baseUrl of ['https://user:secret@gateway.invalid/v1', 'https://gateway.invalid/v1?secret=value',
    'https://gateway.invalid/v1#secret', 'file:///secret', '!secret', '${SECRET}', 'https://bad host/v1']) {
    writeFileSync(f.modelsPath, JSON.stringify({ providers: { alias: { oauth: 'radius', baseUrl } } }));
    await assert.rejects(f.host.snapshot(), error => {
      assert.match(String(error), /safe gateway URL/);
      assert.doesNotMatch(String(error), /secret|SECRET|bad host/);
      return true;
    });
    await assert.rejects(f.host.resolve('alias'), /safe gateway URL/);
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.registrations, []);
});

test('Pi rejects symlink, nonregular and invalid canonical models.json without reading secrets', async t => {
  const f = fixture(t, 'alias');
  const target = join(f.root, 'secret-config');
  writeFileSync(target, 'synthetic-secret-content');
  rmSync(f.modelsPath);
  symlinkSync(target, f.modelsPath);
  await assert.rejects(f.host.snapshot(), /regular file/);
  await assert.rejects(f.host.resolve('alias'), /regular file/);
  rmSync(f.modelsPath);
  mkdirSync(f.modelsPath);
  await assert.rejects(f.host.snapshot(), /regular file/);
  rmSync(f.modelsPath, { recursive: true });
  writeFileSync(f.modelsPath, 'synthetic-secret-content');
  await assert.rejects(f.host.snapshot(), error => {
    assert.match(String(error), /valid JSON/);
    assert.doesNotMatch(String(error), /synthetic-secret-content/);
    return true;
  });
  assert.deepEqual(f.requests, []);
});

test('Pi host does not accept worker endpoints or retain removed native OAuth aliases', { timeout: 10000 }, async t => {
  const f = fixture(t, 'alias');
  await f.host.resolve('alias');
  assert.deepEqual(f.requests, [`${f.gateway()}/v1/oauth/token`]);
  writeFileSync(f.workerModels, JSON.stringify({ providers: { alias: { oauth: 'radius', baseUrl: 'https://worker-forged.invalid/v1' } } }));
  f.expire();
  await f.host.resolve('alias');
  assert.deepEqual(f.requests, [`${f.gateway()}/v1/oauth/token`, `${f.gateway()}/v1/oauth/token`]);
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { alias: { oauth: 'unknown', baseUrl: 'https://unsupported.invalid/v1' } } }));
  await assert.rejects(f.host.resolve('alias'), /does not support native OAuth/);
  assert.equal(f.requests.length, 2);
});
