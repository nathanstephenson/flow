import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebUpdateStatus } from '../src/protocol/update.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { serve } from '../src/daemon/server.ts';

const status: WebUpdateStatus = {
  installedVersion: '1.0.0',
  latestVersion: '2.0.0',
  updateAvailable: true,
  checkedAt: new Date(0).toISOString(),
  eligibility: { state: 'eligible' },
};

test('web update routes require existing authentication, same origin, and explicit fixed confirmation', async () => {
  let starts = 0;
  const updates = {
    status: async () => status,
    start: async () => { starts++; return status; },
  };
  const running = await serve({ host: new SessionHost(), token: 'secret', assets: {}, updates });
  const url = `${running.url}/api/update`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { cookie: 'flow=secret', origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(url, { headers: { cookie: 'flow=secret' } })).status, 200);

    for (const body of [{}, { confirmed: false }, { confirmed: true, version: '9.9.9' }, { confirmed: true, package: 'other' }]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { cookie: 'flow=secret', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(starts, 0, 'cancelled or parameterised requests cannot mutate');

    const accepted = await fetch(url, {
      method: 'POST',
      headers: { cookie: 'flow=secret', 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(accepted.status, 202);
    assert.equal(starts, 1);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
  } finally { await running.close(); }
});
