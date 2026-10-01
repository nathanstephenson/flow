import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareClaudeState } from '../../src/backend/worker/claude-state.ts';
import { claudeAuthFixture } from './claude-auth-fixture.ts';

test('unrestricted relative and literal-tilde config resources resolve against the CLI Scope', t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-config-relative-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = join(root, 'scope'), state = join(root, 'backend');
  mkdirSync(scope); mkdirSync(state);
  for (const configured of ['relative-config', '~']) {
    const config = join(scope, configured); mkdirSync(config);
    writeFileSync(join(config, 'CLAUDE.md'), `resource: ${configured}`);
    const view = prepareClaudeState(state, { HOME: root, CLAUDE_CONFIG_DIR: configured }, scope);
    try {
      assert.equal(readFileSync(join(view.env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md'), 'utf8'), `resource: ${configured}`);
      assert.equal(view.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, configured, 'keep original credential/service spelling');
    } finally { view.cleanup(); }
  }
});

const cli = join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
test('installed Claude keeps default-home OAuth storage and locks with no config override', {
  skip: process.platform !== 'linux' || !existsSync(cli), timeout: 45000,
}, async t => {
  const f = await claudeAuthFixture(t);
  const view = prepareClaudeState(f.state('default-root'), { ...process.env, ...f.env, CLAUDE_CONFIG_DIR: undefined });
  t.after(view.cleanup);
  const child = spawn(cli, ['--print', '--output-format', 'stream-json', '--verbose', 'fixture'], {
    cwd: f.scope, env: view.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  t.after(() => child.kill('SIGKILL'));
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  } finally { clearTimeout(timer); }
  assert.equal(child.signalCode, null, 'normal CLI must finish, not be timed out');
  assert.deepEqual(f.refreshTokens, ['fake-old-refresh']);
  assert.equal(f.credentials().refreshToken, 'fake-new-refresh');
  assert.equal(f.lockSeen(), true);
  assert.equal(existsSync(join(view.env.CLAUDE_CONFIG_DIR!, '.credentials.json')), false);
  view.cleanup();
  assert.equal(f.credentials().refreshToken, 'fake-new-refresh', 'config cleanup cannot discard refreshed credentials');
});
