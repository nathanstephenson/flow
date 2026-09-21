import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explainUnsupportedUpdate, installation, updateUnsupportedReason } from '../src/cli/install-guard.ts';
import { finishWebUpdate, UpdateRefusal, WEB_UPDATE_LAUNCH_WINDOW_MS, WebUpdateController } from '../src/cli/web-update.ts';
import { ReleaseChecker } from '../src/daemon/release-checker.ts';

function fixture(active = false, checker = new ReleaseChecker({ fetch: async () => new Response(JSON.stringify({ version: '2.0.0' })) })) {
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
  writeFileSync(bootstrap, `require('node:fs').writeFileSync(${JSON.stringify(join(temp, 'helper-args'))}, JSON.stringify({ args: process.argv.slice(2), version: process.env.FLOW_WEB_UPDATE_VERSION })); setTimeout(()=>{}, 10000);`);
  const oldPath = process.env.PATH;
  const oldPrefix = process.env.WEB_TEST_PREFIX;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.WEB_TEST_PREFIX = prefix;
  const install = installation(slot);
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

test('web update eligibility explains foreground and embedded hosts, active-work blockers, and npm prefix mismatch', async () => {
  for (const mode of ['foreground', 'embedded'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'flow-web-unsupported-'));
    try {
      const unsupported = new WebUpdateController({
        root, installedVersion: '1.0.0', mode, hasActiveWork: () => false,
        checker: new ReleaseChecker({ fetch: async () => new Response(JSON.stringify({ version: '2.0.0' })) }),
      });
      const eligibility = (await unsupported.status()).eligibility;
      assert.equal(eligibility.state, 'unsupported');
      if (eligibility.state === 'unsupported') assert.match(eligibility.reason, /background Session Host/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  const busy = fixture(true);
  try {
    const blocked = await busy.controller.status();
    assert.equal(blocked.eligibility.state, 'blocked');
    await assert.rejects(busy.controller.start('2.0.0'), UpdateRefusal);

    process.env.WEB_TEST_WRONG_PREFIX = join(busy.temp, 'wrong');
    const mismatched = await busy.controller.status(true);
    assert.equal(mismatched.eligibility.state, 'unsupported');
    delete process.env.WEB_TEST_WRONG_PREFIX;
  } finally { busy.close(); }
});

test('web status truthfully distinguishes source, link, SEA, shared, system, and root installation guidance', async () => {
  const f = fixture();
  const linked = join(f.temp, 'linked-entry');
  try {
    mkdirSync(join(f.temp, 'source'));
    symlinkSync(join(f.temp, 'source'), linked);
    const uid = process.getuid?.();
    assert.notEqual(uid, undefined);
    const cases = [
      explainUnsupportedUpdate(join(f.temp, 'source')),
      explainUnsupportedUpdate(join(f.temp, 'source'), join(linked, 'bootstrap.js')),
      updateUnsupportedReason('sea'),
      (() => { chmodSync(f.prefix, 0o777); const reason = explainUnsupportedUpdate(f.slot); chmodSync(f.prefix, 0o755); return reason; })(),
      explainUnsupportedUpdate(f.slot, undefined, uid! + 1),
      explainUnsupportedUpdate(f.slot, undefined, 0),
    ];
    const patterns = [/source checkout/, /npm-linked/, /Single-executable/, /shared/, /system-owned|another user/, /root-owned|sudo-installed/];
    for (let index = 0; index < cases.length; index++) {
      const controller = new WebUpdateController({
        root: f.root,
        installedVersion: '1.0.0',
        mode: 'background',
        unsupportedReason: cases[index]!,
        hasActiveWork: () => false,
        checker: new ReleaseChecker({ fetch: async () => new Response(JSON.stringify({ version: '2.0.0' })) }),
      });
      const eligibility = (await controller.status()).eligibility;
      assert.equal(eligibility.state, 'unsupported');
      if (eligibility.state === 'unsupported') assert.match(eligibility.reason, patterns[index]!);
    }
  } finally { f.close(); }
});

test('a fixed detached helper is single-flight and success is verified against the running installation', async () => {
  const f = fixture(false);
  try {
    const first = f.controller.start('2.0.0');
    await assert.rejects(f.controller.start('2.0.0'), /already starting/);
    const started = await first;
    assert.equal(started.operation?.state, 'updating');
    assert.deepEqual(JSON.parse(readFileSync(join(f.temp, 'helper-args'), 'utf8')), { args: ['update'], version: '2.0.0' });
    await assert.rejects(f.controller.start('2.0.0'), /already in progress/);

    const id = started.operation!.id;
    finishWebUpdate(f.root, id, { previousVersion: '1.0.0', installedVersion: '2.0.0', changed: true });
    assert.equal((await f.controller.status()).operation?.state, 'unverified', 'a result alone is not success');

    writeFileSync(join(f.slot, 'package.json'), JSON.stringify({ name: '@nathanstephenson/flow', version: '2.0.0' }));
    assert.equal((await f.controller.status()).operation?.state, 'succeeded');
  } finally { f.close(); }
});

test('mutation refreshes latest and refuses a tag that changed after confirmation', async () => {
  for (const changed of ['3.0.0', '1.0.0', '2.0.0-rc.1']) {
    let calls = 0;
    const checker = new ReleaseChecker({ fetch: async () => new Response(JSON.stringify({ version: calls++ === 0 ? '2.0.0' : changed })) });
    const f = fixture(false, checker);
    try {
      assert.equal((await f.controller.status()).latestVersion, '2.0.0');
      await assert.rejects(f.controller.start('2.0.0'), /latest release changed|already up to date|stable semantic version/);
      assert.equal(calls, 2, 'mutation bypasses the cached discovery result');
      assert.throws(() => readFileSync(join(f.temp, 'helper-args')), { code: 'ENOENT' });
    } finally { f.close(); }
  }
});

test('unchanged npm results and recovered failures remain failures', async () => {
  for (const result of ['unchanged', 'failed'] as const) {
    const f = fixture(false);
    try {
      const started = await f.controller.start('2.0.0');
      if (result === 'unchanged') finishWebUpdate(f.root, started.operation!.id, { previousVersion: '1.0.0', installedVersion: '1.0.0', changed: false });
      else finishWebUpdate(f.root, started.operation!.id, undefined, new Error('npm installation failed; token=do-not-expose'));
      const operation = (await f.controller.status()).operation;
      assert.equal(operation?.state, 'failed');
      assert.doesNotMatch(operation?.message ?? '', /do-not-expose/);
    } finally { f.close(); }
  }
});

test('reconciliation cannot overwrite a terminal helper result from a forced interleaving', async t => {
  const f = fixture(false);
  const operationPath = join(f.root, 'web-update.json');
  const deadLauncherPid = 2_147_483_647;
  const kill = process.kill.bind(process);
  let interleaved = false;
  try {
    writeFileSync(operationPath, JSON.stringify({
      id: 'terminal-wins',
      state: 'updating',
      previousVersion: '1.0.0',
      targetVersion: '2.0.0',
      startedAt: new Date().toISOString(),
      message: 'Starting the guarded npm update.',
      launcherPid: deadLauncherPid,
    }));
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadLauncherPid && signal === 0 && !interleaved) {
        interleaved = true;
        finishWebUpdate(f.root, 'terminal-wins', undefined, new Error('npm failed; exact rollback restored Flow 1.0.0'));
        throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
      }
      return kill(pid, signal);
    });

    const status = await f.controller.status();
    assert.equal(interleaved, true, 'the helper finishes after reconciliation reads the updating record');
    assert.equal(status.operation?.state, 'failed', 'the concurrent terminal result is authoritative');
    const stored = JSON.parse(readFileSync(operationPath, 'utf8')) as { id: string; state: string; message?: string };
    assert.deepEqual({ id: stored.id, state: stored.state }, { id: 'terminal-wins', state: 'failed' });
    assert.match(stored.message ?? '', /exact rollback restored Flow 1\.0\.0/);
  } finally { f.close(); }
});

test('a repeated start cannot replace an ownerless provisional operation', async () => {
  let checks = 0;
  const checker = new ReleaseChecker({ fetch: async () => {
    checks++;
    return new Response(JSON.stringify({ version: '2.0.0' }));
  } });
  const f = fixture(false, checker);
  const operationPath = join(f.root, 'web-update.json');
  try {
    writeFileSync(operationPath, JSON.stringify({
      id: 'original-helper',
      state: 'updating',
      previousVersion: '1.0.0',
      targetVersion: '2.0.0',
      startedAt: new Date().toISOString(),
      message: 'Starting the guarded npm update.',
      launcherPid: 2_147_483_647,
    }));

    await assert.rejects(f.controller.start('2.0.0'), /previous update still has an unverified result/i);
    assert.equal(checks, 0, 'the repeated request is refused before another registry check or launch');
    const provisional = JSON.parse(readFileSync(operationPath, 'utf8')) as { id: string; state: string };
    assert.deepEqual({ id: provisional.id, state: provisional.state }, { id: 'original-helper', state: 'unverified' });
    assert.throws(() => readFileSync(join(f.temp, 'helper-args')), { code: 'ENOENT' });

    finishWebUpdate(f.root, 'original-helper', undefined, new Error('the original helper eventually reported recovery'));
    const settled = JSON.parse(readFileSync(operationPath, 'utf8')) as { id: string; state: string; message?: string };
    assert.deepEqual({ id: settled.id, state: settled.state }, { id: 'original-helper', state: 'failed' });
    assert.match(settled.message ?? '', /original helper eventually reported recovery/);
  } finally { f.close(); }
});

test('an ownerless launch becomes recovery-needed after host restart or the bounded launch window', async () => {
  const f = fixture(false);
  const operationPath = join(f.root, 'web-update.json');
  const operation = (id: string, startedAt: string, launcherPid?: number) => ({
    id,
    state: 'updating',
    previousVersion: '1.0.0',
    targetVersion: '2.0.0',
    startedAt,
    message: 'Starting the guarded npm update.',
    ...(launcherPid === undefined ? {} : { launcherPid }),
  });
  try {
    writeFileSync(operationPath, JSON.stringify(operation('within-window', new Date().toISOString(), process.pid)));
    assert.equal((await f.controller.status()).operation?.state, 'updating', 'the launching host gets a safe window to record its helper');

    writeFileSync(operationPath, JSON.stringify(operation('restarted-host', new Date().toISOString(), 2_147_483_647)));
    const restarted = (await f.controller.status()).operation;
    assert.equal(restarted?.state, 'unverified', 'a replacement host must not report an ownerless launch as active forever');
    assert.match(restarted?.message ?? '', /cannot verify whether the update started/i);
    assert.equal('launcherPid' in restarted!, false, 'internal process ownership is not exposed to the browser');

    finishWebUpdate(f.root, 'restarted-host', undefined, new Error('npm failed and exact rollback restored Flow 1.0.0'));
    const eventual = (await f.controller.status()).operation;
    assert.equal(eventual?.state, 'failed', 'an authorized helper may still publish its durable result after provisional reconciliation');
    assert.match(eventual?.message ?? '', /exact rollback restored Flow 1\.0\.0/);

    const stale = new Date(Date.now() - WEB_UPDATE_LAUNCH_WINDOW_MS).toISOString();
    writeFileSync(operationPath, JSON.stringify(operation('legacy-stale-launch', stale)));
    assert.equal((await f.controller.status()).operation?.state, 'unverified', 'legacy ownerless records are bounded by age');
  } finally { f.close(); }
});
