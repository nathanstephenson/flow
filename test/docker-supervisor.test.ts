import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDockerMountSourceSupport, dockerSupervisorLaunch, runDockerSupervisor } from '../src/workflows/docker-supervisor.ts';
import { createCodeExecutors } from '../src/workflows/executors.ts';
import type { ExecutorContext } from '../src/workflows/scheduler.ts';

const refusal = /External sandbox execution refused: Docker bind mount source pinning is not verified/;

test('external mount support and both supervisor APIs fail closed', async () => {
  assert.throws(assertDockerMountSourceSupport, refusal);
  assert.throws(dockerSupervisorLaunch, refusal);
  await assert.rejects(runDockerSupervisor(), refusal);
});

test('direct supervisor entry refuses mutable and proc-fd sources without invoking Docker', () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-docker-refusal-'));
  const marker = join(root, 'docker-invoked');
  const docker = join(root, 'docker');
  const scope = join(root, 'scope');
  mkdirSync(scope);
  writeFileSync(docker, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');`, { mode: 0o700 });
  const fd = openSync(scope, 'r');
  try {
    for (const source of [scope, `/proc/${process.pid}/fd/${fd}`]) {
      const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)), '--flow-docker-supervisor'], {
        input: JSON.stringify({ docker, args: ['--host', 'unix:///var/run/docker.sock', 'run', '--mount', `type=bind,src=${source},dst=/scope`, 'image'],
          name: 'flow-workflow-test', request: { timeout: 1000 } }) + '\n',
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.match(child.stderr, refusal);
      assert.equal(child.stdout, '');
      assert.equal(existsSync(marker), false);
    }
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('executor refuses external Shell and TypeScript before running Docker readiness', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-docker-executor-refusal-'));
  const scope = join(root, 'ancestor', 'scope');
  const docker = join(root, 'docker');
  const calls = join(root, 'docker-calls');
  const runtimePath = join(root, 'runtime.cjs');
  const runtimeMarker = join(root, 'runtime-invoked');
  const shellMarker = join(scope, 'shell-invoked');
  mkdirSync(scope, { recursive: true });
  // Neither local fallback nor container launch may execute this mutable runtime.
  writeFileSync(runtimePath, `require('node:fs').writeFileSync(${JSON.stringify(runtimeMarker)}, 'invoked');`);
  writeFileSync(docker, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');`, { mode: 0o700 });
  try {
    const executors = await createCodeExecutors({ scope, runtimePath, nodePath: process.execPath,
      sandbox: { enabled: true, available: true, image: 'test-image', dockerPath: docker } });
    const base: Omit<ExecutorContext, 'step'> = { sessionId: 's', executionId: 'e', scope, input: null,
      permission: 'auto-accept', signal: new AbortController().signal };
    await assert.rejects(executors.shell.execute({ ...base,
      step: { id: 'shell', name: 'Shell', kind: 'shell', command: 'touch shell-invoked' } }), refusal);
    await assert.rejects(executors.typescript.execute({ ...base,
      step: { id: 'ts', name: 'TypeScript', kind: 'typescript', code: 'return 7;', outputSchema: { type: 'number' } } }), refusal);
    assert.equal(existsSync(runtimeMarker), false);
    assert.equal(existsSync(shellMarker), false);
    assert.equal(existsSync(calls), false, 'even the Docker readiness probe must not run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
