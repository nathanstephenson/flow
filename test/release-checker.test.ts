import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareVersions, newerStableVersion, ReleaseChecker } from '../src/daemon/release-checker.ts';

test('stable semantic comparison offers only a newer stable latest tag', () => {
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0+build.2'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(newerStableVersion('1.2.3', '1.2.4'), true);
  assert.equal(newerStableVersion('1.2.3', '1.2.3'), false);
  assert.equal(newerStableVersion('2.0.0', '1.9.9'), false);
  assert.equal(newerStableVersion('1.2.3', '2.0.0-beta.1'), false);
  assert.throws(() => compareVersions('v1', '1.0.0'), /Invalid semantic version/);
});

test('release checks share a fifteen-minute cache, bypass it manually, and deduplicate in flight', async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  let release!: () => void;
  let blocked = new Promise<void>(resolve => { release = resolve; });
  const checker = new ReleaseChecker({
    now: () => now,
    fetch: async () => {
      calls++;
      await blocked;
      return new Response(JSON.stringify({ version: `1.0.${calls}` }), { status: 200 });
    },
  });

  const first = checker.check();
  const deduplicated = checker.check(true);
  release();
  assert.deepEqual(await first, await deduplicated);
  assert.equal(calls, 1);
  assert.deepEqual(await checker.check(), { checkedAt: new Date(now).toISOString(), latestVersion: '1.0.1' });
  assert.equal(calls, 1);

  blocked = Promise.resolve();
  assert.ok('latestVersion' in await checker.check(true));
  assert.equal(calls, 2);
  now += 15 * 60 * 1000 + 1;
  const expired = await checker.check();
  assert.equal('latestVersion' in expired ? expired.latestVersion : undefined, '1.0.3');
  assert.equal(calls, 3);
});

test('registry HTTP, timeout, malformed tag, and oversized responses remain retryable errors', async () => {
  const cases: Array<{ response?: Response; failure?: Error; matches: RegExp }> = [
    { response: new Response('down', { status: 503 }), matches: /503/ },
    { failure: new DOMException('timed out', 'TimeoutError'), matches: /timed out/i },
    { response: new Response(JSON.stringify({ version: '2.0.0-rc.1' })), matches: /stable semantic version/ },
    { response: new Response('x'.repeat(64 * 1024 + 1)), matches: /too large/ },
  ];
  for (const item of cases) {
    let calls = 0;
    const checker = new ReleaseChecker({ fetch: async () => {
      calls++;
      if (item.failure) throw item.failure;
      return item.response!;
    } });
    const result = await checker.check();
    assert.ok('error' in result);
    assert.match(result.error, item.matches);
    await checker.check(true);
    assert.equal(calls, 2, 'manual refresh retries a cached registry error');
  }
});
