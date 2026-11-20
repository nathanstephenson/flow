import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WorkerBackend } from '../../src/backend/worker/index.ts';
import type { BackendEvent } from '../../src/protocol/events.ts';
import type { PiModelAuth } from '../../src/backend/pi/model-auth.ts';
import { isolationIntegration, privateWorkerState } from '../isolation-fixture.ts';
import { piFixture } from './pi-fixture.ts';
import { fakeProvider } from './sandbox-fixture.ts';

const backendModule = new URL('./worker-pi-auth-fixture.ts', import.meta.url).href;
const entry = fileURLToPath(new URL('../../src/backend/worker/entry.ts', import.meta.url));

test('Pi auth failures do not forward private provider response bodies to workers', { timeout: 10000 }, async t => {
  const { scope, stateDir } = privateWorkerState(t);
  const piAuth: PiModelAuth = {
    async snapshot() { return [{ providerId: 'selected', check: { type: 'oauth', source: 'OAuth' } }]; },
    async resolve() { throw new Error('OAuth refresh failed: {"refresh_token":"synthetic-private-refresh"}'); },
  };
  const backend = new WorkerBackend({ entry, backendModule, isolationMode: () => 'none' });
  const session = await backend.create({ scope, stateDir, piAuth, emit: () => {} });
  t.after(() => session.dispose());
  await assert.rejects(session.prompt('selected'), (error: Error) => {
    assert.match(error.message, /Pi authentication failed/);
    assert.doesNotMatch(error.message, /synthetic-private-refresh|refresh_token/);
    return true;
  });
});

for (const mode of ['none', 'bubblewrap', 'sandbox'] as const) {
  test(`${mode}: Pi workers receive metadata and selected request auth, not the credential file`, {
    ...(mode === 'bubblewrap' ? isolationIntegration : {}), timeout: 15_000,
  }, async t => {
    const f = fakeProvider(t);
    const agent = join(dirname(f.scope), 'pi-auth');
    mkdirSync(agent);
    const canonical = JSON.stringify({ selected: { type: 'oauth', refresh: 'synthetic-refresh', access: 'synthetic-access' } });
    writeFileSync(join(agent, 'auth.json'), canonical);
    const resolved: string[] = [];
    let snapshots = 0;
    let closes = 0;
    const piAuth: PiModelAuth = {
      async close() { closes++; },
      async snapshot() { snapshots++; return [{ providerId: 'selected', check: { type: 'oauth', source: 'OAuth' } }]; },
      async resolve(providerId) { resolved.push(providerId); return { auth: { apiKey: 'synthetic-request-auth' } }; },
    };
    const events: BackendEvent[] = [];
    const backend = new WorkerBackend({ backendModule, entry, stateRoot: f.stateRoot, isolationMode: () => mode,
      sandbox: () => f.support, env: { PI_CODING_AGENT_DIR: agent } });
    const session = await backend.create({ scope: f.scope, stateDir: f.state, piAuth, emit: event => events.push(event) });
    t.after(() => session.dispose());
    assert.equal(snapshots, 1);
    assert.deepEqual(resolved, []);
    await session.prompt('metadata');
    await session.prompt('selected');
    await assert.rejects(session.prompt('unlisted'), /Unknown Pi provider/);
    if (mode !== 'none') {
      await session.prompt('files');
      assert.ok(events.some(event => event.type === 'message' && event.id === 'files' && event.text === 'false'));
    }
    assert.deepEqual(resolved, ['selected']);
    const output = JSON.stringify(events);
    assert.match(output, /synthetic-request-auth/);
    assert.doesNotMatch(output, /synthetic-refresh|synthetic-access/);
    assert.equal(readFileSync(join(agent, 'auth.json'), 'utf8'), canonical);
    await session.dispose();
    assert.equal(readFileSync(join(agent, 'auth.json'), 'utf8'), canonical);
    if (mode === 'sandbox') {
      assert.ok(f.spec().additionalWorkspaces.every(mount => !agent.startsWith(mount.path + '/') && mount.path !== agent));
    }
    await backend.shutdown();
    await backend.shutdown();
    assert.equal(closes, 0, 'Injected Pi auth remains caller-owned');
    await assert.rejects(backend.create({ scope: f.scope, stateDir: f.state, piAuth, emit: () => {} }), /Backend Adapter stopped/);
    assert.equal(snapshots, 1);
  });
}

for (const source of ['models.json', 'auth.json']) test(`${source}: credential commands cannot write outside the worker boundary`, {
  ...isolationIntegration, timeout: 15_000,
}, async t => {
  const f = await piFixture(t, () => ({ text: 'must not request inference' }));
  const marker = join(f.scope, 'forbidden-marker');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');process.stdout.write('synthetic-key')`;
  const command = `!node -e ${JSON.stringify(script)}`;
  if (source === 'auth.json') writeFileSync(join(f.scope, source), JSON.stringify({ 'flow-test': { type: 'api_key', key: command } }));
  else {
    const models = JSON.parse(readFileSync(join(f.scope, source), 'utf8'));
    models.providers['flow-test'].apiKey = command;
    writeFileSync(join(f.scope, source), JSON.stringify(models));
  }
  const { scope, stateDir } = privateWorkerState(t);
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ entry, env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: '1' } });
  const session = await backend.create({ scope, stateDir, modelId: 'flow-test/parent', emit: event => events.push(event) });
  t.after(() => session.dispose());
  await session.prompt('synthetic request');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(f.requests, []);
  assert.ok(events.some(event => event.type === 'turn_ended' && event.reason === 'error'));
});

test('Agent and Summary Model workers share one OAuth rotation and retain it on Revive', {
  ...isolationIntegration, timeout: 20_000,
}, async t => {
  const f = await piFixture(t, () => ({ text: 'synthetic response' }));
  const models = JSON.parse(readFileSync(join(f.scope, 'models.json'), 'utf8'));
  models.providers = { 'openai-codex': { ...models.providers['flow-test'], apiKey: '!false' } };
  writeFileSync(join(f.scope, 'models.json'), JSON.stringify(models));
  const authPath = join(f.scope, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'expired', refresh: 'synthetic-refresh', expires: 0 } }));
  const access = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.test`;
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), 'https://auth.openai.com/oauth/token');
    assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'synthetic-refresh');
    refreshes++;
    return Response.json({ access_token: access, refresh_token: 'rotated-refresh', expires_in: 3600 });
  });
  const { scope, stateDir } = privateWorkerState(t);
  const backend = new WorkerBackend({ entry, env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: '1' } });
  const options = { scope, modelId: 'openai-codex/parent', emit: () => {} };
  const [agent, summary] = await Promise.all([backend.create({ ...options, stateDir }), backend.create({ ...options, tools: 'none' })]);
  t.after(() => Promise.all([agent.dispose(), summary.dispose()]));
  await Promise.all([agent.prompt('agent request'), summary.prompt('summary request')]);
  assert.equal(refreshes, 1);
  assert.equal(f.requests.length, 2);
  const resume = agent.resumeToken();
  await Promise.all([agent.dispose(), summary.dispose()]);
  assert.equal(JSON.parse(readFileSync(authPath, 'utf8'))['openai-codex'].refresh, 'rotated-refresh');
  const revived = await backend.create({ ...options, stateDir, ...(resume ? { resume } : {}) });
  t.after(() => revived.dispose());
  await revived.prompt('revived request');
  assert.equal(refreshes, 1);
  assert.equal(f.requests.length, 3);
});

test('non-Pi workers cannot resolve Pi credentials', { timeout: 15_000 }, async t => {
  const f = fakeProvider(t);
  let resolved = false;
  const backend = new WorkerBackend({ backend: 'claude', backendModule, entry, isolationMode: () => 'none',
    env: { HOME: dirname(f.scope), CLAUDE_CONFIG_DIR: join(dirname(f.scope), 'claude-source'), CLAUDE_SECURESTORAGE_CONFIG_DIR: join(dirname(f.scope), 'claude-source') } });
  await assert.rejects(backend.create({ scope: f.scope, stateDir: f.state, emit: () => {}, piAuth: {
    async snapshot() { return [{ providerId: 'selected', check: { type: 'oauth' } }]; },
    async resolve() { resolved = true; throw new Error('Must not resolve'); },
  } }), /Pi auth is not enabled/);
  assert.equal(resolved, false);
});
