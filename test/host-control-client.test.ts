import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getHostStatus, HostRefusal, launchBackground, requestHostStop } from '../src/cli/host-control.ts';
import type { HostIdentity } from '../src/daemon/ownership.ts';

const settings = { port: 0, address: '127.0.0.1', cwd: process.cwd(), oidc: '' };

test('host client separates status from credentials and checks process identity', async () => {
  const host: HostIdentity = { instanceId: 'instance', pid: process.pid, version: '1.0.0', url: '', token: 'secret', mode: 'background', settings };
  let wrongPid = false;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer secret');
    if (request.method === 'POST') { response.writeHead(409).end('busy'); return; }
    const { token: _token, ...status } = host;
    response.end(JSON.stringify({ ...status, pid: wrongPid ? host.pid + 1 : host.pid, stopping: false }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  host.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal(Object.hasOwn(await getHostStatus(host), 'token'), false);
    await assert.rejects(requestHostStop(host, false), HostRefusal);
    wrongPid = true;
    await assert.rejects(getHostStatus(host), /identity changed/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('background launch refuses a symlinked log without changing its target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-host-log-'));
  try {
    const target = join(root, 'target');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(root, 'host.log'));
    await assert.rejects(launchBackground({ root, settings, entry: [], env: process.env }), /ELOOP/);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
