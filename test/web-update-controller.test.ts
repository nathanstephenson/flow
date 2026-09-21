import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installation } from '../src/cli/install-guard.ts';
import { finishWebUpdate, UpdateRefusal, WebUpdateController } from '../src/cli/web-update.ts';
import { ReleaseChecker } from '../src/daemon/release-checker.ts';

function fixture(active = false) {
  const temp = mkdtempSync(join(tmpdir(), 'flow-web-update-'));
  const prefix = join(temp, 'prefix');
  const slot = join(prefix, 'lib/node_modules/@nathanstephenson/flow');
  const root = join(temp, 'state');
  const bin = join(temp, 'bin');
  mkdirSync(join(slot, 'dist'), { recursive: true });
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(slot, 'package.json'), JSON.stringify({ name: '@nathanstephenson/flow', version: '1.0.0' }));
  writeFileSync(join(slot, 'dist/build-id'), 'fixture');
  const npm = join(bin, 'npm');
  writeFileSync(npm, `#!${process.execPath}\nconst p=require('node:path'); if(process.argv[2]==='prefix') console.log(process.env.WEB_TEST_WRONG_PREFIX || process.env.WEB_TEST_PREFIX); else console.log(p.join(process.env.WEB_TEST_WRONG_PREFIX || process.env.WEB_TEST_PREFIX,'lib/node_modules'));`);
  chmodSync(npm, 0o700);
  const bootstrap = join(temp, 'helper.cjs');
  writeFileSync(bootstrap, `require('node:fs').writeFileSync(${JSON.stringify(join(temp, 'helper-args'))}, JSON.stringify(process.argv.slice(2))); setTimeout(()=>{}, 10000);`);
  const oldPath = process.env.PATH;
  const oldPrefix = process.env.WEB_TEST_PREFIX;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.WEB_TEST_PREFIX = prefix;
  const install = installation(slot);
  const checker = new ReleaseChecker({ fetch: async () => new Response(JSON.stringify({ version: '2.0.0' })) });
  const controller = new WebUpdateController({ root, installedVersion: '1.0.0', mode: 'background', installation: install, bootstrapEntry: bootstrap, hasActiveWork: () => active, checker });
  return {
    temp, prefix, slot, root, controller,
    close() {
      try {
        const pid = (JSON.parse(readFileSync(join(root, 'web-update.json'), 'utf8')) as { pid?: number }).pid;
        if (pid) process.kill(pid, 'SIGTERM');
      } catch {}
      process.env.PATH = oldPath;
      if (oldPrefix === undefined) delete process.env.WEB_TEST_PREFIX;
      else process.env.WEB_TEST_PREFIX = oldPrefix;
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

test('web update eligibility explains unsupported hosts, active-work blockers, and npm prefix mismatch', async () => {
  const unsupported = new WebUpdateController({
    root: mkdtempSync(join(tmpdir(), 'flow-web-unsupported-')),
    installedVersion: '1.0.0', mode: 'foreground', hasActiveWork: () => false,
    checker: new ReleaseChecker({ fetch: async () => new Response(JSON.stringify({ version: '2.0.0' })) }),
  });
  assert.equal((await unsupported.status()).eligibility.state, 'unsupported');

  const busy = fixture(true);
  try {
    const blocked = await busy.controller.status();
    assert.equal(blocked.eligibility.state, 'blocked');
    await assert.rejects(busy.controller.start(), UpdateRefusal);

    process.env.WEB_TEST_WRONG_PREFIX = join(busy.temp, 'wrong');
    const mismatched = await busy.controller.status(true);
    assert.equal(mismatched.eligibility.state, 'unsupported');
    delete process.env.WEB_TEST_WRONG_PREFIX;
  } finally { busy.close(); }
});

test('a fixed detached helper is single-flight and success is verified against the running installation', async () => {
  const f = fixture(false);
  try {
    const first = f.controller.start();
    await assert.rejects(f.controller.start(), /already starting/);
    const started = await first;
    assert.equal(started.operation?.state, 'updating');
    assert.deepEqual(JSON.parse(readFileSync(join(f.temp, 'helper-args'), 'utf8')), ['update']);
    await assert.rejects(f.controller.start(), /already in progress/);

    const id = started.operation!.id;
    finishWebUpdate(f.root, id, { previousVersion: '1.0.0', installedVersion: '2.0.0', changed: true });
    assert.equal((await f.controller.status()).operation?.state, 'unverified', 'a result alone is not success');

    writeFileSync(join(f.slot, 'package.json'), JSON.stringify({ name: '@nathanstephenson/flow', version: '2.0.0' }));
    assert.equal((await f.controller.status()).operation?.state, 'succeeded');
  } finally { f.close(); }
});

test('unchanged npm results and recovered failures remain failures', async () => {
  for (const result of ['unchanged', 'failed'] as const) {
    const f = fixture(false);
    try {
      const started = await f.controller.start();
      if (result === 'unchanged') finishWebUpdate(f.root, started.operation!.id, { previousVersion: '1.0.0', installedVersion: '1.0.0', changed: false });
      else finishWebUpdate(f.root, started.operation!.id, undefined, new Error('npm installation failed; token=do-not-expose'));
      const operation = (await f.controller.status()).operation;
      assert.equal(operation?.state, 'failed');
      assert.doesNotMatch(operation?.message ?? '', /do-not-expose/);
    } finally { f.close(); }
  }
});
