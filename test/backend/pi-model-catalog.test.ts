import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPiModelAuth, createWorkerPiModelRuntime, type PiModelAuth } from '../../src/backend/pi/model-auth.ts';

const cachedModel = {
  id: 'synthetic-radius-cache', name: 'Cached model', reasoning: true, input: ['text', 'image'],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, contextWindow: 32000, maxTokens: 2048,
  thinkingLevelMap: { off: null, high: 'high' }, promptCache: { short: 300, long: 3600 },
  inputLimits: { maxRequestBytes: 1000000, images: { maxPerMessage: 2, maxPerRequest: 4,
    resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 500000, jpegQuality: 80 } } },
};
const access = 'synthetic-radius-access';
const refresh = 'synthetic-radius-refresh';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pi-model-catalog-'));
  const authPath = join(root, 'canonical.json');
  const modelsPath = join(root, 'models.json');
  const credential = { type: 'oauth', access, refresh, expires: Date.now() + 3600000,
    gatewayConfig: { baseUrl: 'https://synthetic.invalid/v1', models: [cachedModel] } };
  writeFileSync(authPath, JSON.stringify({ radius: credential }));
  writeFileSync(modelsPath, JSON.stringify({ providers: { radius: {
    modelOverrides: { [cachedModel.id]: { name: 'Worker override', maxTokens: 4096 } },
  } } }));
  const requests: { url: string; authorization: string | null; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization'), body: init?.body });
    assert.equal(url, 'https://radius.pi.dev/v1/config', `Unexpected network request: ${url}`);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${access}`);
    assert.doesNotMatch(JSON.stringify(init), new RegExp(refresh));
    return Response.json({ baseUrl: 'https://updated.invalid/v1', models: [
      { ...cachedModel, name: 'Gateway update', contextWindow: 64000 },
      { ...cachedModel, id: 'synthetic-radius-fresh' },
    ] });
  });
  const savedRadiusKey = process.env['RADIUS_API_KEY'];
  delete process.env['RADIUS_API_KEY'];
  t.after(() => {
    if (savedRadiusKey === undefined) delete process.env['RADIUS_API_KEY'];
    else process.env['RADIUS_API_KEY'] = savedRadiusKey;
  });
  const host = createPiModelAuth({ authPath });
  let snapshots = 0;
  const resolutions: string[] = [];
  const auth: PiModelAuth = {
    snapshot: signal => { snapshots++; return host.snapshot(signal); },
    resolve: (id, signal) => { resolutions.push(id); return host.resolve(id, signal); },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, authPath, modelsPath, credential, requests, host, auth, resolutions, snapshots: () => snapshots };
}

test('Pi projects only non-secret legacy Radius catalog metadata', { timeout: 10000 }, async t => {
  const f = fixture(t);
  writeFileSync(f.authPath, JSON.stringify({ radius: { ...f.credential, gatewayConfig: {
    baseUrl: 'https://synthetic.invalid/v1', access, refresh, headers: { Authorization: access }, models: [
      { ...cachedModel, headers: { Authorization: access }, access, refresh, extra: { token: refresh },
        thinkingLevelMap: { ...cachedModel.thinkingLevelMap, refresh },
        promptCache: { ...cachedModel.promptCache, refresh },
        inputLimits: { ...cachedModel.inputLimits, refresh, images: { ...cachedModel.inputLimits.images, refresh,
          resize: { ...cachedModel.inputLimits.images.resize, refresh } } },
        cost: { ...cachedModel.cost, access, tiers: [{ ...cachedModel.cost, inputTokensAbove: 1000, refresh }] } },
      { ...cachedModel, id: 'invalid-cost', cost: {} },
      { ...cachedModel, id: 'invalid-input', input: ['secret'] },
      { ...cachedModel, id: 'invalid-number', contextWindow: '32000' },
    ],
  } } }));
  const snapshot = await f.host.snapshot();
  assert.deepEqual(snapshot, [{ providerId: 'radius', check: { type: 'oauth', source: 'OAuth' }, cachedModels: [{
    ...cachedModel, api: 'pi-messages', provider: 'radius', baseUrl: 'https://synthetic.invalid/v1',
    cost: { ...cachedModel.cost, tiers: [{ ...cachedModel.cost, inputTokensAbove: 1000 }] },
  }] }]);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-radius-access|synthetic-radius-refresh|headers|extra/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
});

test('Pi Radius metadata omits credentials embedded in catalog URLs', { timeout: 10000 }, async t => {
  const f = fixture(t);
  for (const baseUrl of ['https://user:secret@synthetic.invalid/v1', 'https://synthetic.invalid/v1?token=secret',
    'https://synthetic.invalid/v1#secret', 'file:///secret', 'not a URL']) {
    writeFileSync(f.authPath, JSON.stringify({ radius: { ...f.credential, gatewayConfig: { baseUrl, models: [cachedModel] } } }));
    assert.deepEqual(await f.host.snapshot(), [{ providerId: 'radius', check: { type: 'oauth', source: 'OAuth' } }]);
  }
  assert.deepEqual(f.requests, []);
});

test('Pi restores legacy Radius models without auth resolution and keeps worker overrides through refresh', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  const model = runtime.getModel('radius', cachedModel.id);
  assert.ok(model);
  assert.equal(model.name, 'Worker override');
  assert.equal(model.maxTokens, 4096);
  assert.equal(model.baseUrl, 'https://synthetic.invalid/v1');
  assert.deepEqual(runtime.getModels('radius').map(entry => entry.id), [cachedModel.id]);
  assert.ok(runtime.getAllModels('radius').some(entry => entry.id === cachedModel.id));
  assert.ok(runtime.getAvailableSnapshot().some(entry => entry.id === cachedModel.id));
  assert.equal(runtime.isUsingOAuth('radius'), true);
  assert.deepEqual(await runtime.listCredentials(), []);
  assert.equal(f.snapshots(), 1);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
  const result = await runtime.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.equal(runtime.getModel('radius', cachedModel.id)?.name, 'Worker override');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
  assert.equal(f.snapshots(), 2);
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { radius: {
    modelOverrides: { [cachedModel.id]: { name: 'Updated worker override' } },
  } } }));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel('radius', cachedModel.id)?.name, 'Updated worker override');
  assert.equal(runtime.getModel('radius', cachedModel.id)?.maxTokens, cachedModel.maxTokens);
  assert.deepEqual(f.requests, []);
});

test('Pi Radius catalog refresh uses broker request auth and persists only in worker model state', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const before = readFileSync(f.authPath, 'utf8');
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  const result = await runtime.refresh({ allowNetwork: true, providers: ['radius'] });
  assert.equal(result.aborted, false);
  assert.deepEqual([...result.errors], []);
  assert.deepEqual(f.resolutions, ['radius']);
  assert.equal(f.requests.length, 1);
  assert.equal(runtime.getModel('radius', cachedModel.id)?.contextWindow, 64000);
  assert.equal(runtime.getModel('radius', cachedModel.id)?.maxTokens, 4096);
  assert.equal(runtime.getModel('radius', cachedModel.id)?.name, 'Worker override');
  assert.equal(runtime.getModel('radius', 'synthetic-radius-fresh')?.baseUrl, 'https://updated.invalid/v1');
  assert.equal(readFileSync(f.authPath, 'utf8'), before);
  assert.doesNotMatch(readFileSync(join(f.root, 'models-store.json'), 'utf8'), /synthetic-radius-access|synthetic-radius-refresh/);
  await runtime.refresh({ allowNetwork: false, providers: ['radius'] });
  assert.ok(runtime.getModel('radius', 'synthetic-radius-fresh'));
  const revived = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.ok(revived.getModel('radius', 'synthetic-radius-fresh'));
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.resolutions, ['radius']);
  assert.equal(f.snapshots(), 4);
});

for (const configured of [true, false]) test(`Pi Radius stored catalogs survive legacy metadata changes and logout, configured: ${configured}`, { timeout: 10000 }, async t => {
  const f = fixture(t);
  const runtime = await createWorkerPiModelRuntime(f.auth, configured ? f.modelsPath : null);
  writeFileSync(f.authPath, JSON.stringify({ radius: { ...f.credential, gatewayConfig: {
    baseUrl: 'https://changed.invalid/v1', models: [{ ...cachedModel, id: 'synthetic-radius-replaced' }],
  } } }));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel('radius', cachedModel.id)?.baseUrl, 'https://synthetic.invalid/v1');
  assert.equal(runtime.getModel('radius', 'synthetic-radius-replaced'), undefined);
  writeFileSync(f.authPath, '{}');
  await runtime.refresh({ allowNetwork: false });
  assert.ok(runtime.getModel('radius', cachedModel.id));
  assert.equal(runtime.getModel('radius', 'synthetic-radius-replaced'), undefined);
  assert.equal(runtime.isUsingOAuth('radius'), false);
  assert.deepEqual(await runtime.getAvailable('radius'), []);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
  assert.equal(f.snapshots(), 3);
});

test('Pi imports an empty legacy Radius account catalog without restoring the baseline', async t => {
  const f = fixture(t);
  writeFileSync(f.authPath, JSON.stringify({ radius: { ...f.credential,
    gatewayConfig: { baseUrl: 'https://synthetic.invalid/v1', models: [] },
  } }));
  const before = readFileSync(f.authPath, 'utf8');
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.deepEqual(runtime.getModels('radius'), []);
  assert.deepEqual(runtime.getAllModels('radius'), []);
  assert.deepEqual(await runtime.getAvailable('radius'), []);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'models-store.json'), 'utf8')).radius.models, []);
  assert.equal(runtime.isUsingOAuth('radius'), true);
  assert.equal(readFileSync(f.authPath, 'utf8'), before);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
});

for (const empty of [false, true]) test(`Pi prefers the stored Radius account catalog over legacy metadata, empty: ${empty}`, async t => {
  const f = fixture(t);
  const models = empty ? [] : [{ ...cachedModel, id: 'stored-only', provider: 'radius', api: 'pi-messages', baseUrl: 'https://stored.invalid/v1' }];
  writeFileSync(join(f.root, 'models-store.json'), JSON.stringify({ radius: { models, checkedAt: Date.now() } }));
  const before = readFileSync(f.authPath, 'utf8');
  for (let i = 0; i < 2; i++) {
    const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
    assert.deepEqual(runtime.getModels('radius').map(model => model.id), models.map(model => model.id));
    assert.deepEqual((await runtime.getAvailable('radius')).map(model => model.id), models.map(model => model.id));
    assert.equal(runtime.getModel('radius', cachedModel.id), undefined);
  }
  assert.equal(readFileSync(f.authPath, 'utf8'), before);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
});

test('Pi leaves custom worker-local Radius gateway definitions intact', { timeout: 10000 }, async t => {
  const f = fixture(t);
  writeFileSync(f.authPath, '{}');
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { radius: {
    oauth: 'radius', baseUrl: 'https://custom.invalid/v1', apiKey: 'synthetic-custom-key',
  } } }));
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    assert.equal(url, 'https://custom.invalid/v1/config');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-custom-key');
    return Response.json({ baseUrl: 'https://custom.invalid/v1', models: [cachedModel] });
  });
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  const result = await runtime.refresh({ allowNetwork: true, providers: ['radius'] });
  assert.deepEqual([...result.errors], []);
  assert.equal(runtime.getModel('radius', cachedModel.id)?.baseUrl, 'https://custom.invalid/v1');
  assert.deepEqual(requests, ['https://custom.invalid/v1/config']);
  assert.deepEqual(f.resolutions, []);
});

test('Pi Radius without stored metadata keeps worker-local API key discovery', { timeout: 10000 }, async t => {
  const f = fixture(t);
  writeFileSync(f.authPath, '{}');
  const saved = process.env['RADIUS_API_KEY'];
  process.env['RADIUS_API_KEY'] = 'synthetic-worker-radius-key';
  t.after(() => {
    if (saved === undefined) delete process.env['RADIUS_API_KEY'];
    else process.env['RADIUS_API_KEY'] = saved;
  });
  const runtime = await createWorkerPiModelRuntime(f.auth, null);
  assert.deepEqual(await runtime.checkAuth('radius'), { type: 'api_key', source: 'RADIUS_API_KEY' });
  assert.equal((await runtime.getAuth('radius'))?.auth.apiKey, 'synthetic-worker-radius-key');
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(await runtime.checkAuth('radius'), { type: 'api_key', source: 'RADIUS_API_KEY' });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.resolutions, []);
});
