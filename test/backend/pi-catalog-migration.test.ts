import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import { createPiModelAuth, createWorkerPiModelRuntime } from '../../src/backend/pi/model-auth.ts';
import { registerPiNativeProvider } from '../../src/backend/pi/model-catalog.ts';

const id = 'corporate-radius';
const model = { id: 'account-only', name: 'Account model', reasoning: false, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 };

function fixture(t: TestContext, models = [model]) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pi-catalog-migration-'));
  const authPath = join(root, 'auth.json');
  const modelsPath = join(root, 'models.json');
  const cachePath = join(root, 'models-store.json');
  const credential = { type: 'oauth', access: 'synthetic-expired', refresh: 'synthetic-refresh', expires: 0,
    gatewayConfig: { baseUrl: 'https://gateway.invalid/v1', models } };
  writeFileSync(authPath, JSON.stringify({ [id]: credential }));
  writeFileSync(modelsPath, JSON.stringify({ providers: { [id]: { oauth: 'radius', baseUrl: 'https://gateway.invalid/v1' } } }));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(String(input), 'https://gateway.invalid/v1/oauth/token');
    assert.ok(existsSync(cachePath));
    requests++;
    return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated', expires_in: 3600 });
  });
  const host = createPiModelAuth({ authPath });
  t.after(async () => { await host.close?.(); rmSync(root, { recursive: true, force: true }); });
  const cache = () => JSON.parse(readFileSync(cachePath, 'utf8'));
  return { root, authPath, modelsPath, cachePath, host, credential, cache, requests: () => requests };
}

for (const empty of [false, true]) test(`Pi host migrates legacy Radius catalogs before rotation and survives auth-owner restart, empty: ${empty}`, async t => {
  const f = fixture(t, empty ? [] : [model]);
  const original = readFileSync(f.authPath, 'utf8');
  await f.host.snapshot();
  assert.equal(existsSync(f.cachePath), false);
  assert.equal(readFileSync(f.authPath, 'utf8'), original);
  assert.equal(f.requests(), 0);
  assert.equal((await f.host.resolve(id))?.auth.apiKey, 'synthetic-access');
  assert.deepEqual(f.cache()[id].models.map((entry: { id: string }) => entry.id), empty ? [] : [model.id]);
  assert.equal(statSync(f.cachePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f.authPath, 'utf8'))[id].gatewayConfig, undefined);
  assert.doesNotMatch(readFileSync(f.cachePath, 'utf8'), /synthetic-expired|synthetic-access|synthetic-refresh|synthetic-rotated/);
  await f.host.close?.();
  const restarted = createPiModelAuth({ authPath: f.authPath });
  t.after(() => restarted.close?.());
  const metadata = await restarted.snapshot();
  assert.deepEqual(metadata[0]?.cachedModels?.map(entry => entry.id), empty ? [] : [model.id]);
  const state = join(f.root, 'new-worker');
  mkdirSync(state);
  const workerModels = join(state, 'models.json');
  writeFileSync(workerModels, readFileSync(f.modelsPath));
  const worker = await createWorkerPiModelRuntime(restarted, workerModels);
  assert.deepEqual(worker.getModels(id).map(entry => entry.id), empty ? [] : [model.id]);
  assert.deepEqual((await worker.getAvailable(id)).map(entry => entry.id), empty ? [] : [model.id]);
  assert.equal(existsSync(join(state, 'auth.json')), false);
  assert.equal(f.requests(), 1);
});

for (const empty of [false, true]) test(`Pi host preserves a newer canonical Radius account catalog, empty: ${empty}`, async t => {
  const f = fixture(t);
  const models = empty ? [] : [{ ...model, id: 'stored-only', provider: id, api: 'pi-messages', baseUrl: 'https://stored.invalid/v1',
    headers: { Authorization: 'synthetic-private-header' }, access: 'synthetic-private-access' }];
  const stored = { [id]: { models, checkedAt: 123, etag: 'validator' }, unrelated: { models: [], checkedAt: 456 } };
  writeFileSync(f.cachePath, JSON.stringify(stored));
  const before = readFileSync(f.cachePath, 'utf8');
  const metadata = await f.host.snapshot();
  assert.deepEqual(metadata[0]?.cachedModels?.map(entry => entry.id), models.map(entry => entry.id));
  assert.doesNotMatch(JSON.stringify(metadata), /synthetic-private-header|synthetic-private-access|Authorization/);
  assert.equal((await f.host.resolve(id))?.auth.apiKey, 'synthetic-access');
  assert.equal(readFileSync(f.cachePath, 'utf8'), before);
  assert.deepEqual(f.cache(), stored);
  assert.equal(f.requests(), 1);
});

for (const kind of ['symbolic link', 'hard link', 'directory', 'invalid JSON', 'array', 'oversized'] as const) {
  test(`Pi host refuses a ${kind} catalog before rotating credentials`, async t => {
    const f = fixture(t);
    if (kind === 'symbolic link') symlinkSync(f.authPath, f.cachePath);
    if (kind === 'hard link') linkSync(f.authPath, f.cachePath);
    if (kind === 'directory') mkdirSync(f.cachePath);
    if (kind === 'invalid JSON') writeFileSync(f.cachePath, 'synthetic-private-content');
    if (kind === 'array') writeFileSync(f.cachePath, '[]');
    if (kind === 'oversized') { writeFileSync(f.cachePath, '{}'); truncateSync(f.cachePath, 16 * 1024 * 1024 + 1); }
    const before = readFileSync(f.authPath, 'utf8');
    await assert.rejects(f.host.snapshot(), error => {
      assert.match(String(error), /models-store.json/);
      assert.doesNotMatch(String(error), /synthetic-private-content/);
      return true;
    });
    await assert.rejects(f.host.resolve(id));
    assert.equal(readFileSync(f.authPath, 'utf8'), before);
    assert.equal(f.requests(), 0);
    assert.equal(existsSync(`${f.authPath}.lock`), false);
    assert.equal(existsSync(`${f.cachePath}.lock`), false);
  });
}

test('Pi host migration shares the SDK model-store lock and preserves other catalogs and file mode', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const unrelated = { models: [], checkedAt: 456 };
  writeFileSync(f.cachePath, JSON.stringify({ unrelated }));
  chmodSync(f.cachePath, 0o640);
  const external = await ModelRuntime.create({ authPath: f.authPath, modelsPath: f.modelsPath, refreshOnCreate: false });
  registerPiNativeProvider(external, {
    id: 'synthetic-cache', name: 'Synthetic catalog', auth: {}, getModels: () => [],
    stream() { throw new Error('No inference'); }, streamSimple() { throw new Error('No inference'); },
    async refreshModels(context) { await context.publish({ persist: { models: [], checkedAt: 789 } }); },
  });
  const release = await lockfile.lock(f.cachePath, { realpath: false, stale: 30000 });
  const resolving = f.host.resolve(id);
  const refreshing = external.refresh({ providers: ['synthetic-cache'], allowNetwork: false });
  try {
    await sleep(40);
    assert.equal(f.requests(), 0);
    assert.deepEqual(f.cache(), { unrelated });
  } finally { await release(); }
  assert.equal((await resolving)?.auth.apiKey, 'synthetic-access');
  assert.deepEqual([...(await refreshing).errors], []);
  assert.deepEqual(f.cache().unrelated, unrelated);
  assert.deepEqual(f.cache()['synthetic-cache'], { models: [], checkedAt: 789 });
  assert.deepEqual(f.cache()[id].models.map((entry: { id: string }) => entry.id), [model.id]);
  assert.equal(statSync(f.cachePath).mode & 0o777, 0o640);
  assert.deepEqual([...(await external.refresh({ providers: [id], allowNetwork: false })).errors], []);
  assert.equal(external.getModel(id, model.id)?.baseUrl, 'https://gateway.invalid/v1');
  assert.equal(f.requests(), 1);
  assert.equal(existsSync(`${f.authPath}.lock`), false);
  assert.equal(existsSync(`${f.cachePath}.lock`), false);
});
