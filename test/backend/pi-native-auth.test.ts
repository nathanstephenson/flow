import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthResult, CredentialStore } from '@earendil-works/pi-ai';
import { createPiModelAuth, createWorkerPiModelRuntime, type PiModelAuth, type PiProviderAuth } from '../../src/backend/pi/model-auth.ts';

const model = { id: 'synthetic', name: 'Synthetic', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pi-native-auth-'));
  const modelsPath = join(root, 'models.json');
  const saved = Object.fromEntries(['HOME', 'PI_DIR', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'RADIUS_API_KEY', 'AWS_PROFILE',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].map(name => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  Object.assign(process.env, { HOME: root, PI_DIR: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: '1' });
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    throw new Error(`Unexpected network request: ${String(input)}`);
  });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let entries: readonly PiProviderAuth[] = [{ providerId: 'radius', check: { type: 'api_key', source: 'stored credential' } }];
  let selected: AuthResult | undefined = { auth: { apiKey: '${SELECTED_KEY}' }, env: { SELECTED_KEY: 'stored-key' } };
  const resolutions: string[] = [];
  const auth: PiModelAuth = {
    async snapshot() { return entries; },
    async resolve(id, signal) { signal?.throwIfAborted(); resolutions.push(id); return selected; },
  };
  const configure = (id = 'radius', apiKey = 'configured-key', headers: Record<string, string> = {}) => {
    writeFileSync(modelsPath, JSON.stringify({ providers: { [id]: {
      api: 'openai-completions', baseUrl: 'https://inference.invalid/v1', apiKey, headers, models: [model],
    } } }));
  };
  const requests: string[] = [];
  const catalog = (expected: string, gateway = 'https://radius.pi.dev') => {
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      assert.equal(url, `${gateway}/v1/config`, `Unexpected network request: ${url}`);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${expected}`);
      requests.push(url);
      return Response.json({ baseUrl: 'https://catalog.invalid/v1', models: [{ ...model, id: 'catalog-model' }] });
    });
  };
  configure();
  return { root, modelsPath, auth, configure, resolutions, requests, catalog,
    metadata: (next: readonly PiProviderAuth[]) => { entries = next; },
    selected: (next: AuthResult | undefined) => { selected = next; } };
}

for (const id of ['radius', 'native-alias']) for (const type of ['api_key', 'oauth'] as const) test(`native Radius ${id} ${type} owns inference and network catalog auth`, async t => {
  const f = fixture(t);
  const marker = join(f.root, 'configured-command');
  const gateway = id === 'radius' ? 'https://radius.pi.dev' : 'https://canonical-gateway.invalid';
  f.configure(id, `!touch ${marker}`);
  f.metadata([{ providerId: id, check: { type }, ...(id === 'radius' ? {} : { radiusGateway: gateway }) }]);
  if (type === 'oauth') f.selected({ auth: { apiKey: 'stored-oauth', headers: { 'X-Native': 'oauth' } } });
  const expected = type === 'api_key' ? 'stored-key' : 'stored-oauth';
  f.catalog(expected, gateway);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.deepEqual(f.resolutions, []);
  assert.equal(runtime.isUsingOAuth(id), type === 'oauth');
  assert.equal((await runtime.getAuth(id))?.auth.apiKey, expected);
  const result = await runtime.refresh({ allowNetwork: true, providers: [id] });
  assert.deepEqual([...result.errors], []);
  assert.deepEqual(f.resolutions, [id, id]);
  assert.deepEqual(f.requests, [`${gateway}/v1/config`]);
  assert.equal(runtime.getModel(id, 'catalog-model')?.baseUrl, 'https://inference.invalid/v1');
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(readFileSync(join(f.root, 'models-store.json'), 'utf8'), /stored-key|stored-oauth|SELECTED_KEY/);
});

test('native Radius explicit overrides do not resolve stored keys, including equal raw values', async t => {
  const f = fixture(t);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  for (const apiKey of ['explicit-key', '${SELECTED_KEY}', 'stored-key']) {
    assert.equal((await runtime.getAuth('radius', { apiKey }))?.auth.apiKey, apiKey);
  }
  assert.deepEqual(f.resolutions, []);
  assert.equal((await runtime.getAuth('radius', { env: { SELECTED_KEY: 'override-env' } }))?.auth.apiKey, 'override-env');
  assert.deepEqual(f.resolutions, ['radius']);
  f.selected({ auth: { apiKey: '${SELECTED_KEY}' }, env: { SELECTED_KEY: 'new-key' } });
  assert.equal((await runtime.getAuth('radius'))?.auth.apiKey, 'new-key');
  assert.deepEqual(f.resolutions, ['radius', 'radius']);
});

test('native Radius logout and config reload restore SDK fallback without stale stored templates', async t => {
  const f = fixture(t);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.equal((await runtime.getAuth('radius'))?.auth.apiKey, 'stored-key');
  f.metadata([]);
  f.configure('radius', 'reloaded-fallback', { 'X-Reloaded': 'yes' });
  await runtime.refresh({ allowNetwork: false });
  const result = await runtime.getAuth('radius');
  assert.equal(result?.auth.apiKey, 'reloaded-fallback');
  assert.equal(result?.auth.headers?.['X-Reloaded'], 'yes');
  f.catalog('reloaded-fallback');
  assert.deepEqual([...(await runtime.refresh({ allowNetwork: true, providers: ['radius'] })).errors], []);
  assert.deepEqual(f.resolutions, ['radius']);
});

for (const stored of [false, true]) test(`worker-local Radius gateway reload replaces default catalog routing, stored: ${stored}`, async t => {
  const f = fixture(t);
  if (!stored) f.metadata([]);
  const configure = (gateway?: string) => writeFileSync(f.modelsPath, JSON.stringify({ providers: { radius: {
    apiKey: 'worker-key', ...(gateway ? { oauth: 'radius', baseUrl: `${gateway}/v1` } : {}),
  } } }));
  configure();
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  f.metadata([]);
  for (const gateway of ['https://worker-one.invalid', 'https://worker-two.invalid', 'https://radius.pi.dev']) {
    configure(gateway === 'https://radius.pi.dev' ? undefined : gateway);
    f.catalog('worker-key', gateway);
    assert.deepEqual([...(await runtime.refresh({ allowNetwork: true, providers: ['radius'] })).errors], []);
  }
  assert.deepEqual(f.requests, ['https://worker-one.invalid/v1/config', 'https://worker-two.invalid/v1/config', 'https://radius.pi.dev/v1/config']);
  assert.deepEqual(f.resolutions, []);
});

test('API-key checks, lists, and availability never request host secrets', async t => {
  const f = fixture(t);
  f.selected(undefined);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.deepEqual(await runtime.checkAuth('radius'), { type: 'api_key', source: 'stored credential' });
  assert.ok((await runtime.getAvailable('radius')).length);
  assert.ok((await runtime.getAllAvailable('radius')).length);
  assert.deepEqual(await runtime.listCredentials(), []);
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(f.resolutions, []);
  assert.equal(await runtime.getAuth('radius'), undefined);
});

test('worker OAuth placeholders contain no tokens and cannot trigger SDK refresh', async t => {
  const f = fixture(t);
  f.metadata([{ providerId: 'radius', check: { type: 'oauth' } }]);
  let store: CredentialStore | undefined;
  const create = ModelRuntime.create;
  t.mock.method(ModelRuntime, 'create', async (options: Parameters<typeof create>[0]) => {
    store = options?.credentials;
    return create.call(ModelRuntime, options);
  });
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.deepEqual(await store?.read('radius'), { type: 'oauth', access: '', refresh: '', expires: Number.MAX_SAFE_INTEGER });
  await assert.rejects(runtime.getAuth('radius', { minOAuthValidityMs: Number.MAX_SAFE_INTEGER }), /read-only/);
  await assert.rejects(runtime.logout('radius'), /read-only/);
  assert.deepEqual(f.resolutions, []);
});

test('native Bedrock env-only credentials keep the genuine provider resolution', async t => {
  const f = fixture(t);
  f.metadata([{ providerId: 'amazon-bedrock', check: { type: 'api_key', source: 'stored credential' } }]);
  f.selected({ auth: {}, env: { AWS_PROFILE: 'synthetic-profile' } });
  const runtime = await createWorkerPiModelRuntime(f.auth, null);
  assert.deepEqual(f.resolutions, []);
  assert.deepEqual(await runtime.getAuth('amazon-bedrock'), {
    auth: {}, env: { AWS_PROFILE: 'synthetic-profile' }, source: 'stored credential',
  });
  assert.deepEqual(f.resolutions, ['amazon-bedrock']);
});

test('native ambient auth and worker commands need no host credential resolution', async t => {
  const f = fixture(t);
  f.metadata([]);
  process.env['RADIUS_API_KEY'] = 'ambient-key';
  const ambient = await createWorkerPiModelRuntime(f.auth, null);
  assert.equal((await ambient.getAuth('radius'))?.auth.apiKey, 'ambient-key');
  const marker = join(f.root, 'worker-command');
  f.configure('radius', `!printf x >> ${marker}; printf worker-key`);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.equal(existsSync(marker), false);
  assert.equal((await runtime.getAuth('radius'))?.auth.apiKey, 'worker-key');
  assert.equal(readFileSync(marker, 'utf8'), 'x');
  assert.deepEqual(f.resolutions, []);
});

test('custom auth-only definitions keep SDK provider and model header composition', async t => {
  const f = fixture(t);
  f.metadata([{ providerId: 'custom', check: { type: 'api_key' } }]);
  f.selected({ auth: { apiKey: '${SELECTED_KEY}' }, env: { SELECTED_KEY: 'custom-key', HEADER: 'selected-header' } });
  const marker = join(f.root, 'header-command');
  writeFileSync(f.modelsPath, JSON.stringify({ providers: { custom: {
    api: 'openai-completions', baseUrl: 'https://inference.invalid/v1', apiKey: '!false', authHeader: true,
    headers: { 'X-Provider': `!printf x >> ${marker}; printf provider-header`, 'X-Env': '${HEADER}' },
    models: [{ ...model, headers: { Authorization: 'model-auth', 'X-Model': '${HEADER}' } }],
  } } }));
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath);
  assert.equal(existsSync(marker), false);
  const result = await runtime.getAuth(runtime.getModel('custom', model.id)!);
  assert.equal(result?.auth.apiKey, 'custom-key');
  assert.deepEqual(result?.auth.headers, { 'X-Provider': 'provider-header', 'X-Env': 'selected-header',
    Authorization: 'model-auth', 'X-Model': 'selected-header' });
  assert.equal(readFileSync(marker, 'utf8'), 'x');
});

test('native stored API-key templates expand only in the worker, never canonical commands', async t => {
  const f = fixture(t);
  const authPath = join(f.root, 'auth.json');
  const marker = join(f.root, 'host-command');
  writeFileSync(authPath, JSON.stringify({ radius: { type: 'api_key', key: '${SELECTED_KEY}', env: { SELECTED_KEY: 'host-selected' } } }));
  f.configure('radius', `!touch ${marker}`, { 'X-Host': `!touch ${marker}` });
  const host = createPiModelAuth({ authPath });
  t.after(() => host.close?.());
  const workerModels = join(f.root, 'worker-models.json');
  writeFileSync(workerModels, JSON.stringify({ providers: { radius: { apiKey: 'wrong-worker-key' } } }));
  const runtime = await createWorkerPiModelRuntime(host, workerModels);
  assert.equal((await runtime.getAuth('radius'))?.auth.apiKey, 'host-selected');
  assert.equal(existsSync(marker), false);
});
