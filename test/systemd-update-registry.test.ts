import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createSystemdTestRegistry } from '../scripts/systemd-update-registry.mjs';

test('fixture registry avoids stale socket reuse after dependency resolution and retains HTTP failures', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'flow-registry-test-'));
  const paths: string[] = [];
  const registry = createSystemdTestRegistry((request, response) => {
    paths.push(request.url ?? '/');
    response.statusCode = request.url === '/failure' ? 503 : 200;
    response.end(request.url === '/failure' ? 'controlled failure' : 'fixture');
  });
  registry.keepAliveTimeout = 1000;
  registry.keepAliveTimeoutBuffer = 0;
  try {
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    assert.ok(address && typeof address !== 'string');
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { Agent, get } from 'node:http';
      import { setImmediate } from 'node:timers/promises';
      const agent = new Agent({ keepAlive: true, maxSockets: 1, agentKeepAliveTimeoutBuffer: 0 });
      const request = path => new Promise((resolve, reject) => {
        get('http://127.0.0.1:${address.port}' + path, { agent }, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, connection: response.headers.connection, body }));
          response.on('error', reject);
        }).on('error', reject);
      });
      try {
        const metadata = await request('/metadata');
        await setImmediate();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1400);
        const tarball = await request('/tarball');
        const failure = await request('/failure');
        console.log(JSON.stringify([metadata, tarball, failure]));
      } finally {
        agent.destroy();
      }
    `], { env: { HOME: home }, cwd: home, timeout: 5000 });
    assert.deepEqual(JSON.parse(stdout), [
      { status: 200, connection: 'close', body: 'fixture' },
      { status: 200, connection: 'close', body: 'fixture' },
      { status: 503, connection: 'close', body: 'controlled failure' },
    ]);
    assert.deepEqual(paths, ['/metadata', '/tarball', '/failure']);
  } finally {
    registry.closeAllConnections();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
