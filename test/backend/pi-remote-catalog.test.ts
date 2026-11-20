import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { PiBackend } from '../../src/backend/pi/index.ts';
import { createWorkerPiModelRuntime, type PiModelAuth } from '../../src/backend/pi/model-auth.ts';

function fixture(t: TestContext, radius = false) {
  const root = mkdtempSync(join(tmpdir(), 'flow-pi-remote-catalog-'));
  const modelsPath = join(root, 'models.json');
  const modelsStorePath = join(root, 'catalog-cache.json');
  const model = { ...builtinProviders().find(provider => provider.id === 'anthropic')!.getModels()[0]!,
    id: 'synthetic-new-model', name: 'Catalog model' };
  writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: {
    modelOverrides: { [model.id]: { name: 'Local override' } },
  } } }));
  const saved = process.env['PI_OFFLINE'];
  delete process.env['PI_OFFLINE'];
  t.after(() => {
    if (saved === undefined) delete process.env['PI_OFFLINE'];
    else process.env['PI_OFFLINE'] = saved;
    rmSync(root, { recursive: true, force: true });
  });
  const resolutions: string[] = [];
  t.after(() => assert.deepEqual(resolutions, []));
  const auth: PiModelAuth = {
    snapshot: async () => [
      { providerId: 'anthropic', check: { type: 'oauth', source: 'OAuth' } },
      ...(radius ? [{ providerId: 'radius', check: { type: 'oauth' as const, source: 'OAuth' } }] : []),
    ],
    resolve: async id => {
      resolutions.push(id);
      return assert.fail('Catalog metadata must not resolve authentication');
    },
  };
  const requests: string[] = [];
  let status = 200;
  let models = [model];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://pi.dev');
    assert.equal(url.pathname, '/api/models/providers/anthropic');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    requests.push(url.href);
    return Response.json(models, { status, headers: {
      'last-modified': 'Thu, 01 Jan 2099 00:00:00 GMT', etag: '"synthetic-catalog"',
    } });
  });
  return { root, auth, modelsPath, modelsStorePath, model, requests,
    fail: () => { status = 400; },
    update: () => { models = [...models, { ...model, id: 'synthetic-second-model' }]; },
    seed: () => writeFileSync(modelsStorePath, JSON.stringify({ anthropic: {
      models: [model], checkedAt: Date.now(), lastModified: Date.parse('2099-01-01'), etag: '"synthetic-catalog"',
    } })),
  };
}

test('Pi restores remote catalog models under host-owned auth without network or auth resolution', async t => {
  const f = fixture(t);
  f.seed();
  writeFileSync(join(f.root, 'models-store.json'), readFileSync(f.modelsStorePath));
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, { modelsStorePath: f.modelsStorePath });
  assert.equal(runtime.getModel('anthropic', f.model.id)?.name, 'Local override');
  assert.ok(runtime.getAvailableSnapshot().some(model => model.id === f.model.id));
  assert.equal(runtime.isUsingOAuth('anthropic'), true);
  assert.deepEqual(f.requests, []);
});

test('Pi automatically discovers public catalogs without refreshing Radius or OAuth', async t => {
  const f = fixture(t, true);
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, {
    modelsStorePath: f.modelsStorePath, discovery: 'automatic',
  });
  assert.equal(f.requests.length, 1);
  assert.equal(runtime.getModel('anthropic', f.model.id)?.name, 'Local override');
  assert.ok(runtime.getAvailableSnapshot().some(model => model.id === f.model.id));
  assert.ok(JSON.parse(readFileSync(f.modelsStorePath, 'utf8')).anthropic.models.some((model: { id: string }) => model.id === f.model.id));
});

test('PiBackend selects a newly discovered model before inference and persists its private catalog', async t => {
  const f = fixture(t);
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = f.root;
  t.after(() => {
    if (saved === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = saved;
  });
  const stateDir = join(f.root, 'worker-state');
  const session = await new PiBackend().create({ scope: f.root, stateDir, tools: 'none', piAuth: f.auth,
    modelId: `anthropic/${f.model.id}`, emit() {} });
  try {
    assert.ok(session.capabilities.models.some(model => model.id === `anthropic/${f.model.id}`));
    assert.equal(f.requests.length, 1);
    assert.ok(JSON.parse(readFileSync(join(stateDir, 'models-store.json'), 'utf8')).anthropic.models
      .some((model: { id: string }) => model.id === f.model.id));
  } finally { await session.dispose(); }
});

test('Pi explicit catalog refresh bypasses freshness and keeps persisted models available to later workers', async t => {
  const f = fixture(t);
  f.seed();
  const options = { modelsStorePath: f.modelsStorePath, discovery: 'automatic' as const };
  const cached = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, options);
  assert.ok(cached.getModel('anthropic', f.model.id));
  assert.deepEqual(f.requests, []);
  f.update();
  const updated = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, { ...options, discovery: 'refresh' });
  assert.ok(updated.getModel('anthropic', 'synthetic-second-model'));
  assert.equal(f.requests.length, 1);
  const revived = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, options);
  assert.ok(revived.getModel('anthropic', 'synthetic-second-model'));
  assert.equal(f.requests.length, 1);
});

test('Pi failed catalog refresh preserves the last usable models', async t => {
  const f = fixture(t);
  f.seed();
  f.fail();
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, {
    modelsStorePath: f.modelsStorePath, discovery: 'refresh',
  });
  assert.ok(runtime.getAvailableSnapshot().some(model => model.id === f.model.id));
  assert.equal(f.requests.length, 1);
});

test('Pi catalog deadline stops a stalled refresh and keeps cached models available', async t => {
  const f = fixture(t);
  f.seed();
  const timeout = AbortSignal.timeout;
  let deadlines = 0;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    if (ms !== 5_000) return timeout(ms);
    deadlines++;
    return timeout(20);
  });
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    assert.ok(init?.signal);
    const signal = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(keepAlive));
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, {
    modelsStorePath: f.modelsStorePath, discovery: 'refresh',
  });
  assert.equal(deadlines, 1);
  assert.ok(runtime.getAvailableSnapshot().some(model => model.id === f.model.id));
});

test('Pi offline mode prevents even explicit network model discovery', async t => {
  const f = fixture(t);
  f.seed();
  process.env['PI_OFFLINE'] = '1';
  const runtime = await createWorkerPiModelRuntime(f.auth, f.modelsPath, undefined, {
    modelsStorePath: f.modelsStorePath, discovery: 'refresh',
  });
  assert.ok(runtime.getModel('anthropic', f.model.id));
  assert.deepEqual(f.requests, []);
});
