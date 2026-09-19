import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replacePackage } from '../src/cli/install-process.ts';

test('npm cleanup waits for confirmed exit after transient permission errors', async t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-install-process-'));
  const npm = join(root, 'npm');
  writeFileSync(npm, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  const kill = process.kill.bind(process);
  let probes = 0;
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && ++probes <= 3) throw Object.assign(new Error('still exiting'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  try {
    await replacePackage(npm, root, 'fixture');
    assert.ok(probes >= 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
