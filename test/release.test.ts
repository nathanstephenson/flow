import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/check-release.mjs');

test('release validation requires a stable matching version on main', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'flow-release-'));
  const env = { ...process.env, GITHUB_REF_NAME: 'v1.2.3', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  const check = (tag = 'v1.2.3') => spawnSync(process.execPath, [script], { cwd, env: { ...env, GITHUB_REF_NAME: tag }, encoding: 'utf8' });
  const metadata = { name: '@nathanstephenson/flow', version: '1.2.3' };
  const lock = { version: '1.2.3', packages: { '': metadata } };
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(metadata));
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
    git('init', '--initial-branch=main');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'release');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(check().status, 0);
    for (const tag of ['v1.2.4', 'v1.2.3-rc.1', '1.2.3', 'v01.2.3', 'v1.2']) assert.notEqual(check(tag).status, 0, tag);
    for (const invalid of [{ ...lock, version: '1.2.2' }, { ...lock, packages: { '': { ...metadata, version: '1.2.2' } } }]) {
      writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(invalid));
      assert.notEqual(check().status, 0);
    }
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ ...metadata, private: true }));
    assert.notEqual(check().status, 0);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(metadata));
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'not on main');
    assert.notEqual(check().status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
