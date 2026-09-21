import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionHost } from '../src/daemon/host.ts';
import { readHost } from '../src/daemon/ownership.ts';
import { startRuntime } from '../src/daemon/runtime.ts';

test('an ordinary ephemeral background host retains the dynamic-port restart request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-runtime-port-'));
  const runtime = await startRuntime({ root, version: '1.0.0', mode: 'background', port: 0, assets: () => ({}), workflowRuntime: () => '/unused' });
  try {
    const selected = Number(new URL(runtime.running.url).port);
    assert.ok(selected > 0);
    assert.equal(readHost(root)?.settings.port, 0);
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ['rejection', 'timeout']) {
  test(`runtime shutdown ${failure} retains ownership without repeating partial shutdown`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'flow-runtime-stop-'));
    const oidc = Object.entries(process.env).filter(([key]) => key.startsWith('FLOW_OIDC_'));
    for (const [key] of oidc) delete process.env[key];
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const shutdown = t.mock.method(SessionHost.prototype, 'shutdown', async () => {
      if (failure === 'rejection') throw new Error('blocked shutdown');
      await pending;
    });
    const runtime = await startRuntime({ root, version: '1.0.0', mode: 'embedded', assets: () => ({}), workflowRuntime: () => '/unused' });
    const drain = runtime.running.stopAdmission;
    runtime.running.stopAdmission = interrupt => drain(interrupt, 20);
    try {
      await assert.rejects(runtime.stop(), /blocked shutdown|drain timed out/);
      assert.equal(readHost(root)?.pid, process.pid);
      assert.equal(existsSync(join(root, 'host.lock')), true);
      const response = await fetch(`${runtime.daemon.url}/api/sessions`, { headers: { authorization: `Bearer ${runtime.daemon.token}` } });
      assert.equal(response.status, 503);
      await assert.rejects(runtime.stop(), /blocked shutdown|drain timed out/);
      assert.equal(shutdown.mock.callCount(), 1);
      assert.equal(readHost(root)?.pid, process.pid);
      assert.equal(existsSync(join(root, 'host.lock')), true);
    } finally {
      finish();
      await pending;
      await runtime.running.close();
      for (const [key, value] of oidc) process.env[key] = value;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
