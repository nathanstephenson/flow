import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionHost } from '../src/daemon/host.ts';
import { readHost } from '../src/daemon/ownership.ts';
import { startRuntime } from '../src/daemon/runtime.ts';

test('failed runtime shutdown retains ownership and can be retried without reopening admission', async t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-runtime-stop-'));
  const oidc = Object.entries(process.env).filter(([key]) => key.startsWith('FLOW_OIDC_'));
  for (const [key] of oidc) delete process.env[key];
  let fail = true;
  t.mock.method(SessionHost.prototype, 'shutdown', async () => { if (fail) throw new Error('blocked shutdown'); });
  const runtime = await startRuntime({ root, version: '1.0.0', mode: 'embedded', assets: () => ({}), workflowRuntime: () => '/unused' });
  try {
    await assert.rejects(runtime.stop(), /blocked shutdown/);
    assert.equal(readHost(root)?.pid, process.pid);
    assert.equal(existsSync(join(root, 'host.lock')), true);
    const response = await fetch(`${runtime.daemon.url}/api/sessions`, { headers: { authorization: `Bearer ${runtime.daemon.token}` } });
    assert.equal(response.status, 503);
    fail = false;
    await runtime.stop();
    assert.equal(readHost(root), undefined);
    assert.equal(existsSync(join(root, 'host.lock')), false);
  } finally {
    fail = false;
    await runtime.stop();
    for (const [key, value] of oidc) process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
