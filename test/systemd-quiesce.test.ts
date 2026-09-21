import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionHost } from '../src/daemon/host.ts';
import { serve } from '../src/daemon/server.ts';
import type { HostIdentity } from '../src/daemon/ownership.ts';

test('systemd quiesce closes admission without exiting, refuses busy work and unmanaged hosts', async () => {
  const previous = process.env.FLOW_SYSTEMD_HOST;
  delete process.env.FLOW_SYSTEMD_HOST;
  const host = new SessionHost();
  let stops = 0, busy = false;
  const identity = { instanceId: 'managed', token: 'secret', mode: 'foreground' } as HostIdentity;
  const server = await serve({ host, token: 'secret', assets: {}, control: {
    identity, hasActiveWork: () => busy, stop: async () => { stops++; },
  } });
  const headers = { authorization: 'Bearer secret', connection: 'close' };
  const quiesce = () => fetch(`${server.url}/api/host/stop`, {
    method: 'POST', headers, body: JSON.stringify({ instanceId: 'managed', quiesce: true }),
  });
  try {
    assert.equal((await quiesce()).status, 409);
    process.env.FLOW_SYSTEMD_HOST = '1';
    busy = true;
    assert.equal((await quiesce()).status, 409);
    busy = false;
    assert.equal((await quiesce()).status, 202);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 0);
    assert.equal((await fetch(`${server.url}/api/command`, { method: 'POST', headers, body: '{}' })).status, 503);
    assert.equal((await fetch(`${server.url}/api/host`, { headers })).status, 200);
    const resume = () => fetch(`${server.url}/api/host/stop`, { method: 'POST', headers, body: JSON.stringify({ instanceId: 'managed', resume: true }) });
    assert.equal((await resume()).status, 202);
    const resumed = await (await fetch(`${server.url}/api/host`, { headers })).json() as { stopping: boolean };
    assert.equal(resumed.stopping, false);
    assert.notEqual((await fetch(`${server.url}/api/no-such-route`, { headers })).status, 503);
    assert.equal((await resume()).status, 409, 'ordinary admission is not a paused update');
    assert.equal((await quiesce()).status, 202);
    await server.stopAdmission();
    assert.equal((await resume()).status, 409, 'real shutdown cannot be undone by resuming quiescence');
  } finally {
    if (previous === undefined) delete process.env.FLOW_SYSTEMD_HOST;
    else process.env.FLOW_SYSTEMD_HOST = previous;
    await host.shutdown();
    await server.close();
  }
});
