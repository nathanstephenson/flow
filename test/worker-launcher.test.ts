import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { killWorkerTree } from '../src/backend/worker/launcher.ts';

const failure = (code: string) => () => { throw Object.assign(new Error(`kill ${code}`), { code }); };

test('process group kill ignores EPERM only after the worker exited', { skip: process.platform === 'win32' }, async t => {
  t.mock.method(process, 'kill', failure('EPERM'));
  await killWorkerTree({ pid: 1, exitCode: 0, signalCode: null } as ChildProcess);
  await killWorkerTree({ pid: 1, exitCode: null, signalCode: 'SIGTERM' } as ChildProcess);
  await assert.rejects(killWorkerTree({ pid: 1, exitCode: null, signalCode: null } as ChildProcess), /EPERM/);
});
