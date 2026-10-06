// Fatal CI prerequisite, not a skippable integration test. Probe the production boundary,
// not merely whether Bubblewrap is installed or a user namespace can be created.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareFilesystemIsolation } from '../src/isolation/filesystem.ts';

assert.equal(process.platform, 'linux', 'This CI prerequisite requires Linux');
// Keep the canary on the read-only host mount, not /tmp (which is private writable scratch).
const root = mkdtempSync(join(process.cwd(), '.flow-ci-boundary-'));
const scope = join(root, 'scope');
const outside = join(root, 'outside');
const inside = join(scope, 'inside');
mkdirSync(scope);
writeFileSync(outside, 'host canary');
let boundary;
try {
  boundary = await prepareFilesystemIsolation({
    scope, command: process.execPath, credentials: 'none',
    args: ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(inside)}, 'scope canary');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, 'escaped'),
        error => ['EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(error.code));
    `],
  });
  const result = spawnSync(boundary.command, boundary.args, {
    env: boundary.env, stdio: ['ignore', 'pipe', 'pipe', ...boundary.stdioFds],
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Filesystem boundary probe failed: ${result.stderr}`);
  assert.equal(readFileSync(inside, 'utf8'), 'scope canary');
  assert.equal(readFileSync(outside, 'utf8'), 'host canary');
  console.log('Linux filesystem isolation: Scope writes allowed, host writes refused.');
} finally {
  boundary?.cleanup();
  rmSync(root, { recursive: true, force: true });
}
