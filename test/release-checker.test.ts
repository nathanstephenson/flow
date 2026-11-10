import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareVersions, isReleaseVersion, newerReleaseVersion, ReleaseChecker } from '../src/daemon/release-checker.ts';

test('update targets are exact stable or beta releases, not tags or arbitrary prereleases', () => {
  for (const version of ['0.0.0', '2.0.0', '2.0.0+build.1', '0.1.9-beta.1', '2.0.0-beta.0']) {
    assert.equal(isReleaseVersion(version), true, version);
  }
  for (const version of ['', 'latest', 'beta', '^2.0.0', 'v2.0.0', '02.0.0', '2.0.0-rc.1', '2.0.0-beta', '2.0.0-beta.01', '2.0.0-beta.1+build.1']) {
    assert.equal(isReleaseVersion(version), false, version);
  }
});

test('stable semantic comparison offers only a newer stable latest tag', () => {
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0+build.2'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(newerReleaseVersion('1.2.3', '1.2.4'), true);
  assert.equal(newerReleaseVersion('1.2.3', '1.2.3'), false);
  assert.equal(newerReleaseVersion('2.0.0', '1.9.9'), false);
  assert.equal(newerReleaseVersion('1.2.3', '2.0.0-beta.1'), true);
  assert.equal(newerReleaseVersion('1.2.3', '2.0.0-rc.1'), false);
  assert.equal(newerReleaseVersion('1.2.3', '1.2.3-beta.1'), false);
  assert.equal(newerReleaseVersion('1.3.0-beta.0', '1.2.9'), false);
  assert.equal(newerReleaseVersion('1.3.0-beta.0', '1.3.0'), true);
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

test('the beta channel offers the higher of the latest and beta tags, cached apart from stable', async () => {
  const tags: Record<string, string> = { latest: '1.2.0', beta: '1.3.0-beta.1' };
  const urls: string[] = [];
  const checker = new ReleaseChecker({ registryUrl: 'http://registry/pkg', fetch: async input => {
    const url = String(input);
    urls.push(url);
    const version = tags[url.slice(url.lastIndexOf('/') + 1)];
    return version ? new Response(JSON.stringify({ version })) : new Response('{}', { status: 404 });
  } });
  assert.equal((await checker.check(false, 'stable') as { latestVersion: string }).latestVersion, '1.2.0');
  assert.deepEqual(urls, ['http://registry/pkg/latest']);
  assert.equal((await checker.check(false, 'beta') as { latestVersion: string }).latestVersion, '1.3.0-beta.1');
  tags.latest = '1.3.0';
  assert.equal((await checker.check(true, 'beta') as { latestVersion: string }).latestVersion, '1.3.0');
  assert.equal((await checker.check(false, 'stable') as { latestVersion: string }).latestVersion, '1.2.0');
  delete tags.beta;
  assert.equal((await checker.check(true, 'beta') as { latestVersion: string }).latestVersion, '1.3.0');
  tags.beta = '1.4.0-rc.1';
  const invalid = await checker.check(true, 'beta');
  assert.ok('error' in invalid);
  assert.match(invalid.error, /beta/);
});
