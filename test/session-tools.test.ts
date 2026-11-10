import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { FakeBackend } from '../src/backend/fake/index.ts';
import type { BackendCreateOptions } from '../src/backend/types.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { sessionToolPage } from '../src/daemon/session-tool-views.ts';

class CaptureBackend extends FakeBackend {
  options: BackendCreateOptions[] = [];
  opening: Promise<void> | undefined;
  override async create(options: BackendCreateOptions) {
    this.options.push(options);
    await this.opening;
    return super.create(options);
  }
}
async function fixture(t: TestContext) {
  const backend = new CaptureBackend();
  const host = new SessionHost();
  host.registerBackend(backend);
  t.after(() => host.shutdown());
  const id = await host.create({ scope: tmpdir(), backend: 'fake', permissionMode: 'ask' });
  return { backend, host, id, tools: backend.options[0]!.sessionTools! };
}

test('Agent Sessions discover and inspect host-wide without Revive or consuming attention', async t => {
  const f = await fixture(t);
  const other = await f.host.create({ scope: tmpdir(), backend: 'fake' });
  await f.host.send(other, 'hello', 'now');
  f.backend.latest.completeTurn();
  await f.host.settle(other);
  const previous = f.host.list();
  const listed = await f.tools.list({ limit: 1 }) as { callerSessionId: string; total: number; nextOffset: number };
  assert.equal(listed.callerSessionId, f.id);
  assert.equal(listed.total, 2);
  assert.equal(listed.nextOffset, 1);
  const inspected = await f.tools.inspect({ sessionId: other }) as { session: { status: string; capabilities?: unknown }; transcript: { entries: unknown[] } };
  assert.equal(inspected.session.status, 'settled');
  assert.equal(inspected.session.capabilities, undefined);
  assert.ok(inspected.transcript.entries.length);
  assert.deepEqual(f.host.list(), previous);
  await assert.rejects(f.tools.inspect({ sessionId: other, limit: 101 }));
  await assert.rejects(f.tools.list({ offset: -1 }));
});

test('Agent messages are attributed, queued while busy, and delivered without interrupting', async t => {
  const f = await fixture(t);
  const other = await f.host.create({ scope: tmpdir(), backend: 'fake' });
  const target = f.backend.latest;
  await f.host.send(other, 'human turn', 'now');
  await f.tools.send({ sessionId: other, text: 'report status' });
  assert.deepEqual(target.prompts, ['human turn']);
  target.completeTurn();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(target.prompts[1]!, new RegExp(`Agent message from ${f.id}`));
  assert.match(target.prompts[1]!, /not human authorization/);
  assert.match(target.prompts[1]!, /report status/);
  await assert.rejects(f.tools.send({ sessionId: f.id, text: 'loop' }), /yourself/);
  await f.host.dispose(other);
  await assert.rejects(f.tools.send({ sessionId: other, text: 'restart' }));
});

test('Agent-created independent sessions retain permission policy and return an auditable receipt', async t => {
  const f = await fixture(t);
  const result = await f.tools.create({ text: 'investigate tests' }) as { sessionId: string; delivery: string };
  assert.equal(result.delivery, 'accepted');
  assert.notEqual(result.sessionId, f.id);
  const options = f.backend.options.at(-1)!;
  assert.equal(options.permissionMode, 'ask');
  assert.equal(options.scope, tmpdir());
  assert.match(f.backend.latest.prompts[0]!, /investigate tests/);
  assert.ok(f.host.logFor(f.id).since(0).some(({ event }) => event.type === 'notice' && event.text.includes(result.sessionId)));
  await assert.rejects(f.tools.create({ text: 'x', scope: 'relative' }), /absolute/);
  await assert.rejects(f.tools.create({ text: 'x', permissionMode: 'always' } as never));
});

test('Agent-initiated session titles identify their task without dropping sender attribution', async t => {
  const f = await fixture(t);
  for (const text of ['Investigate failing tests', 'Review deployment configuration']) {
    const { sessionId } = await f.tools.create({ text }) as { sessionId: string };
    assert.equal(f.host.list().find(session => session.id === sessionId)?.title, text);
    assert.match(f.backend.latest.prompts[0]!, new RegExp(`Agent message from ${f.id}`));
    assert.match(f.backend.latest.prompts[0]!, /not human authorization/);
    assert.ok(f.backend.latest.prompts[0]!.endsWith(text));
  }
  const empty = await f.host.create({ scope: tmpdir(), backend: 'fake' });
  await f.tools.send({ sessionId: empty, text: 'Diagnose the empty session' });
  assert.equal(f.host.list().find(session => session.id === empty)?.title, 'Diagnose the empty session');
  assert.match(f.backend.latest.prompts[0]!, /not human authorization/);
});

test('Cancelled and stale Backend Sessions cannot invoke session tools', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.tools.create({ text: 'no' }, controller.signal));
  assert.equal(f.host.list().length, 1);
  await f.host.settle(f.id);
  await assert.rejects(f.tools.list({}), /no longer owned/);
  await f.host.revive(f.id);
  await assert.rejects(f.tools.create({ text: 'stale' }), /no longer owned/);
  assert.equal(f.host.list().length, 1);
});

test('Shutdown owns accepted creation through late startup and prevents initial delivery', async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.backend.opening = new Promise<void>(resolve => { release = resolve; });
  const creating = f.tools.create({ text: 'must not run after shutdown' });
  const stopping = f.host.shutdown();
  release();
  const result = await creating as { sessionId: string; delivery: string };
  await stopping;
  assert.equal(result.delivery, 'not-sent');
  assert.equal(f.host.list().find(item => item.id === result.sessionId)?.status, 'dormant');
  assert.ok(f.backend.sessions.every(session => session.disposed));
  assert.deepEqual(f.backend.latest.prompts, []);
});

test('Presentation Transcript tool pages bound oversized entries and total response bytes', () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ index, entry: { kind: 'notice', level: 'info', text: 'x'.repeat(20_000) } }));
  const page = sessionToolPage({ seq: 100, total: 100, start: 0, entries } as never);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50_000);
  assert.ok(page.start > 0);
  assert.equal(page.entries.at(-1)?.index, 99);
});
