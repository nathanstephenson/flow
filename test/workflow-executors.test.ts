import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { createCodeExecutors } from '../src/workflows/executors.ts';
import type { ExecutorContext } from '../src/workflows/scheduler.ts';
import type { VisualSchema } from '../src/protocol/workflows.ts';
const scope = mkdtempSync(join(tmpdir(), 'flow-code-'));
const runtimeDirectory = mkdtempSync(join(tmpdir(), 'flow-runtime-test-'));
const runtimePath = join(runtimeDirectory, 'runtime.cjs');
before(() => { execFileSync(process.execPath, ['scripts/build-workflow-runtime.mjs', runtimePath]); });
after(() => { rmSync(scope, { recursive: true, force: true }); rmSync(runtimeDirectory, { recursive: true, force: true }); });
const local = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox: { enabled: false }, resolveSecret: async () => 'private-value' });
const context = (code: string, outputSchema: VisualSchema = { type: 'number' }): ExecutorContext => ({ sessionId: 's', executionId: 'e', scope, input: { value: 4 }, inputSchema: { type: 'object', fields: { value: { schema: { type: 'number' }, required: true } } }, step: { id: 'a', name: 'a', kind: 'typescript', code, outputSchema }, permission: 'auto-accept', signal: new AbortController().signal });
test('TypeScript checks types, transforms JSON and rejects unsupported APIs', async () => {
  assert.equal(await local.typescript.execute(context('return input.value * 2;')), 8);
  for (const code of ['return "wrong";', 'return process.pid;', 'import fs from "node:fs"; return 1;', 'return input.missing;']) await assert.rejects(local.typescript.execute(context(code)));
  assert.equal(await local.typescript.execute(context('return Function("return typeof process + typeof require")();', { type: 'string' })), 'undefinedundefined');
  for (const code of ['return "wrong" as any;', 'return NaN;', 'return Infinity;', 'return Function("return import(\\"node:fs\\")")();']) await assert.rejects(local.typescript.execute(context(code)));
});
test('scoped files and symlink checks', async () => {
  assert.equal(await local.typescript.execute(context('await fs.mkdir("artifacts"); await fs.writeText("artifacts/a", "hello"); return await fs.readText("artifacts/a");', { type: 'string' })), 'hello');
  symlinkSync('/etc', join(scope, 'escape'));
  for (const path of ['/etc/passwd', '../etc/passwd', 'escape/passwd']) await assert.rejects(local.typescript.execute(context(`return await fs.readText(${JSON.stringify(path)});`, { type: 'string' })));
  await assert.rejects(local.typescript.execute(context('await fs.writeText("escape/flow-no", "x"); return 1;')));
});
test('intermediate symlink swaps cannot redirect file opens', { timeout: 10000 }, async () => {
  const directory = join(scope, 'race'), saved = join(scope, 'race-saved'), outside = join(runtimeDirectory, 'outside');
  mkdirSync(directory); mkdirSync(outside);
  writeFileSync(join(directory, 'value'), 'inside'); writeFileSync(join(outside, 'value'), 'outside');
  const source = `const fs = require('node:fs'); while(true) { fs.renameSync(${JSON.stringify(directory)}, ${JSON.stringify(saved)}); fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(directory)}); fs.unlinkSync(${JSON.stringify(directory)}); fs.renameSync(${JSON.stringify(saved)}, ${JSON.stringify(directory)}); }`;
  const racer = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  try {
    assert.equal(await local.typescript.execute(context('for (let i = 0; i < 100; i++) { try { if (await fs.readText("race/value") === "outside") return false; await fs.writeText("race/value", "inside"); } catch {} } return true;', { type: 'boolean' })), true);
    assert.equal(readFileSync(join(outside, 'value'), 'utf8'), 'outside');
  } finally { racer.kill('SIGKILL'); await new Promise(resolve => racer.once('close', resolve)); }
});
test('HTTP fetch preserves large responses and bounds redirects', async () => {
  const server = createServer((req, res) => { if (req.url === '/large') res.end('x'.repeat(100_001)); else if (req.url === '/redirect') { res.writeHead(302, { location: '/redirect' }); res.end(); } else res.end('hello'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(await local.typescript.execute(context(`return (await fetch('${url}')).text();`, { type: 'string' })), 'hello');
    assert.equal(await local.typescript.execute(context(`return (await fetch('${url}/large')).body;`, { type: 'string' })), 'x'.repeat(100_001));
    for (const path of ['/redirect']) await assert.rejects(local.typescript.execute(context(`return (await fetch('${url}${path}')).body;`, { type: 'string' })));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('configured deadline permits eleven seconds of IO followed by CPU work', { timeout: 25000 }, async () => {
  const server = createServer((_req, res) => { setTimeout(() => res.end('ok'), 11000); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = context(`await fetch('http://127.0.0.1:${(server.address() as { port: number }).port}'); let n = 0; for (let i = 0; i < 100000; i++) n++; return n;`);
  ctx.step.timeoutMs = 20000;
  try { assert.equal(await local.typescript.execute(ctx), 100000); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('quoted multiline secrets are redacted before thrown errors are encoded', async () => {
  const secret = 'quote"secret\nvalue';
  const executor = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox: { enabled: false }, resolveSecret: async () => secret });
  for (const code of ['throw new Error(secrets.KEY);', 'throw { message: secrets.KEY, nested: { detail: secrets.KEY }, [secrets.KEY]: secrets.KEY };', 'throw secrets.KEY;']) {
    const ctx = context(code); ctx.step.secrets = { KEY: 'reference' };
    await assert.rejects(executor.typescript.execute(ctx), (error: Error) => {
      assert.ok(error.message.includes('[REDACTED]'));
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes(JSON.stringify(secret).slice(1, -1)));
      return true;
    });
  }
});
test('CPU, cancellation, large output and sandbox memory protection', { timeout: 10000 }, async () => {
  const infinite = context('while(true) {}'); infinite.step.timeoutMs = 250;
  await assert.rejects(local.typescript.execute(infinite));
  const controller = new AbortController(); const cancelled = context('while(true) {}'); cancelled.signal = controller.signal;
  const result = local.typescript.execute(cancelled); setTimeout(() => controller.abort(), 200);
  await assert.rejects(result);
  assert.equal(await local.typescript.execute(context('return "x".repeat(100001);', { type: 'string' })), 'x'.repeat(100001));
  await assert.rejects(local.typescript.execute(context('return "x".repeat(64 * 1024 * 1024);', { type: 'string' })));
});
test('Shell passes JSON without interpolation, honours cancellation and removes inherited credentials', async () => {
  process.env.FLOW_TEST_CREDENTIAL = 'must-not-leak';
  const ctx = context(''); ctx.input = { text: '$(touch injected)' }; ctx.step = { id: 'a', name: 'a', kind: 'shell', command: 'printf "%s" "$OUTPUT"; printf "%s" "${FLOW_TEST_CREDENTIAL-unset}" >&2; exit 7' };
  assert.deepEqual(await local.shell.execute(ctx), { exitCode: 7, stdout: JSON.stringify(ctx.input), stderr: 'unset' });
  ctx.step.command = 'while true; do sleep 1; done'; ctx.step.timeoutMs = 100; await assert.rejects(local.shell.execute(ctx));
  delete process.env.FLOW_TEST_CREDENTIAL;
});
test('explicit unavailable sandbox fails; disabled runs; named secrets stay out of env and output', async () => {
  const unavailable = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox: { enabled: true, available: false, image: 'none' } });
  assert.throws(() => unavailable.typescript.check(context('').step, { sessionId: 's', scope, backend: 'pi' }), /unavailable/);
  const ctx = context('return secrets.KEY;', { type: 'string' }); ctx.step.secrets = { KEY: 'reference' };
  assert.equal(await local.typescript.execute(ctx), '[REDACTED]');
  const quoted = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox: { enabled: false }, resolveSecret: async () => 'secret"\nvalue' });
  assert.equal(await quoted.typescript.execute(ctx), '[REDACTED]');
  const unsafe = context(''); unsafe.step = { id: 'a', name: 'a', kind: 'shell', command: 'true', secrets: { BASH_ENV: 'reference' } };
  assert.throws(() => local.shell.check(unsafe.step, { sessionId: 's', scope, backend: 'pi' }), /Unsafe/);
});
test('slow Docker readiness probe preserves another Agent Session Shell heartbeat', { timeout: 25000 }, async () => {
  const dockerPath = join(runtimeDirectory, 'slow-docker');
  writeFileSync(dockerPath, `#!${process.execPath}\nsetTimeout(() => process.exit(1), 4000);`, { mode: 0o700 });
  const marker = join(scope, 'probe-shell-started');
  const ctx = context('');
  ctx.sessionId = 'other-session';
  ctx.step = { id: 'a', name: 'a', kind: 'shell', timeoutMs: 22000, command: 'touch probe-shell-started; sleep 20; printf healthy' };
  const work = local.shell.execute(ctx);
  const result = assert.doesNotReject(async () => {
    assert.deepEqual(await work, { exitCode: 0, stdout: 'healthy', stderr: '' });
  });
  await waitFor(() => existsSync(marker));
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 100);
  try {
    const executor = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox: { enabled: true, available: true, image: 'test', dockerPath } });
    assert.ok(ticks >= 20, `Heartbeat ran only ${ticks} times during probe`);
    assert.throws(() => executor.shell.check(ctx.step, { sessionId: 's', scope, backend: 'pi' }), /External sandbox is enabled but unavailable/);
  } finally { clearInterval(heartbeat); await result; }
});

test('external mode requires host Node and reports container cleanup failure', async () => {
  const dockerPath = join(runtimeDirectory, 'fake-docker');
  writeFileSync(dockerPath, `#!${process.execPath}\nif (process.argv.includes('rm')) { console.error('cleanup-canary'); process.exit(1); } if (process.argv.includes('run')) console.log(JSON.stringify({output: 7}));`, { mode: 0o700 });
  const sandbox = { enabled: true as const, available: true, image: 'owned-test-image', dockerPath };
  const unavailable = await createCodeExecutors({ runtimePath, nodePath: '/missing-node', sandbox });
  assert.throws(() => unavailable.typescript.check(context('').step, { sessionId: 's', scope, backend: 'pi' }), /Host Node/);
  const executor = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox });
  await assert.rejects(executor.typescript.execute(context('return 7;')), /Docker container cleanup failed: cleanup-canary/);
});
const image = 'mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm';
const dockerAvailable = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', image], { stdio: 'ignore' }).status === 0;
test('Docker executes QuickJS and Shell with restricted mount and environment', { skip: !dockerAvailable }, async () => {
  const docker = await createCodeExecutors({ runtimePath, nodePath: process.execPath, sandbox: { enabled: true, available: true, image } });
  assert.equal(await docker.typescript.execute(context('return input.value + 3;')), 7);
  assert.equal(await docker.typescript.execute(context('await fs.mkdir("docker-artifacts"); await fs.writeText("docker-artifacts/a", "ok"); return await fs.readText("docker-artifacts/a");', { type: 'string' })), 'ok');
  symlinkSync('/etc', join(scope, 'docker-escape'));
  for (const path of ['/etc/passwd', 'docker-escape/passwd']) await assert.rejects(docker.typescript.execute(context(`return await fs.readText(${JSON.stringify(path)});`, { type: 'string' })));
  const infinite = context('while (true) {}'); infinite.step.timeoutMs = 500;
  await assert.rejects(docker.typescript.execute(infinite));
  writeFileSync(join(runtimeDirectory, 'host-secret'), 'private');
  const ctx = context(''); ctx.step = { id: 'a', name: 'a', kind: 'shell', command: `set -e; test ! -S /var/run/docker.sock; test ! -e ${runtimeDirectory}/host-secret; test "$(awk '/CapEff/{print $2}' /proc/self/status)" = 0000000000000000; if touch /tmp/flow-must-not-write 2>/dev/null; then exit 1; fi; printf "%s" "$OUTPUT"` };
  assert.deepEqual(await docker.shell.execute(ctx), { exitCode: 0, stdout: JSON.stringify(ctx.input), stderr: '' });
});

function procText(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
const children = (pid: number) => procText(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/).filter(Boolean).map(Number);
const commandLine = (pid: number) => procText(`/proc/${pid}/cmdline`).split('\0');
const dockerSupervisor = (pid: number) => children(pid).find(child => commandLine(child).includes('--docker-supervisor'));
const dockerCli = (pid: number) => children(pid).find(child => {
  const args = commandLine(child);
  return args.includes('run') && args.includes('--name') && args[args.indexOf('--name') + 1]?.startsWith('flow-workflow-');
});

async function waitFor(check: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Wait timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
for (const mode of ['local', 'docker'] as const) test(`host loss stops owned Shell work (${mode})`, { skip: mode === 'docker' && !dockerAvailable, timeout: 15000 }, async () => {
  const marker = join(scope, `orphan-${mode}`);
  const ctx = context('');
  ctx.step = { id: 'a', name: 'a', kind: 'shell', command: `while true; do printf x >> orphan-${mode}; sleep 0.1; done & wait` };
  const settings = { runtimePath, nodePath: process.execPath, sandbox: mode === 'docker' ? { enabled: true, available: true, image } : { enabled: false } };
  const source = `import { createCodeExecutors } from ${JSON.stringify(new URL('../src/workflows/executors.ts', import.meta.url).href)}; const ctx = ${JSON.stringify(ctx)}; ctx.signal = new AbortController().signal; await (await createCodeExecutors(${JSON.stringify(settings)})).shell.execute(ctx);`;
  const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: 'ignore' });
  try {
    await waitFor(() => existsSync(marker));
    let cli: number | undefined;
    if (mode === 'docker' && process.platform === 'linux') await waitFor(() => {
      const supervisor = dockerSupervisor(host.pid!);
      cli = supervisor === undefined ? undefined : dockerCli(supervisor);
      return cli !== undefined;
    });
    host.kill('SIGKILL');
    for (const pid of cli === undefined ? [] : [cli]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await new Promise(resolve => host.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 4500));
    const size = readFileSync(marker).length;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(readFileSync(marker).length, size);
  } finally { host.kill('SIGKILL'); }
});
for (const failure of ['host-cli', 'heartbeat', 'deadline', 'kill-inner'] as const) test(`outside Docker lease survives inner supervisor attack (${failure})`, { skip: !dockerAvailable || process.platform !== 'linux', timeout: 18000 }, async () => {
  const marker = join(scope, `attack-${failure}`);
  const ctx = context('');
  ctx.step = { id: 'a', name: 'a', kind: 'shell', timeoutMs: failure === 'deadline' ? 5000 : 60000, command: `kill -${failure === 'kill-inner' ? 'KILL' : 'STOP'} "$PPID"; while true; do printf x >> attack-${failure}; sleep 0.1; done` };
  const settings = { runtimePath, nodePath: process.execPath, sandbox: { enabled: true, available: true, image } };
  const source = `import { createCodeExecutors } from ${JSON.stringify(new URL('../src/workflows/executors.ts', import.meta.url).href)}; const ctx = ${JSON.stringify(ctx)}; ctx.signal = new AbortController().signal; await (await createCodeExecutors(${JSON.stringify(settings)})).shell.execute(ctx);`;
  const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { stdio: 'ignore' });
  let name = '';
  try {
    let cli: number | undefined;
    await waitFor(() => {
      const supervisor = dockerSupervisor(host.pid!);
      cli = supervisor === undefined ? undefined : dockerCli(supervisor);
      if (cli === undefined) return false;
      const args = commandLine(cli);
      name = args[args.indexOf('--name') + 1] ?? '';
      return name.startsWith('flow-workflow-');
    });
    assert.match(name, /^flow-workflow-/);
    if (failure !== 'kill-inner') await waitFor(() => existsSync(marker));
    if (failure === 'heartbeat') host.kill('SIGSTOP');
    if (failure === 'host-cli' || failure === 'kill-inner') {
      host.kill('SIGKILL');
      try { process.kill(cli!, 'SIGKILL'); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
    }
    await new Promise(resolve => setTimeout(resolve, failure === 'deadline' ? 6500 : 4000));
    assert.notEqual(spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', name], { stdio: 'ignore' }).status, 0);
    const size = existsSync(marker) ? readFileSync(marker).length : 0;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(existsSync(marker) ? readFileSync(marker).length : 0, size);
  } finally {
    host.kill('SIGKILL');
    if (name.startsWith('flow-workflow-')) spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'rm', '--force', name], { stdio: 'ignore', timeout: 5000 });
  }
});
test('cancellation drains an active fetch and ignores late results', { timeout: 10000 }, async () => {
  let closed = false, requested = false;
  const server = createServer((req, _res) => { requested = true; req.on('close', () => { closed = true; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const ctx = context(`return (await fetch('http://127.0.0.1:${(server.address() as { port: number }).port}')).status;`);
  ctx.signal = controller.signal;
  const work = local.typescript.execute(ctx);
  try { await waitFor(() => requested); controller.abort(); await assert.rejects(work); await waitFor(() => closed); }
  finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SEA extracts a complete runtime and runs without source-relative assets', { skip: process.platform !== 'linux' || process.versions.node.split('.')[0] !== '22' ? 'SEA packaging requires the supported Linux Node 22 toolchain' : false, timeout: 30000 }, () => {
  const entry = join(runtimeDirectory, 'sea-entry.cjs');
  const binary = join(runtimeDirectory, 'sea-flow');
  const blob = join(runtimeDirectory, 'sea.blob');
  const config = join(runtimeDirectory, 'sea.json');
  const executors = fileURLToPath(new URL('../src/workflows/executors.ts', import.meta.url));
  const asset = fileURLToPath(new URL('../src/workflows/runtime-asset.ts', import.meta.url));
  buildSync({ stdin: { contents: `import { createCodeExecutors } from ${JSON.stringify(executors)}; import { embeddedWorkflowRuntime } from ${JSON.stringify(asset)}; const ctx = ${JSON.stringify(context('return input.value * 3;'))}; ctx.signal = new AbortController().signal; createCodeExecutors({runtimePath: embeddedWorkflowRuntime(), nodePath: ${JSON.stringify(process.execPath)}, sandbox: {enabled:false}}).then(executors => executors.typescript.execute(ctx)).then(value => console.log(value), error => { console.error(error); process.exitCode = 1; });`, resolveDir: process.cwd() }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  writeFileSync(config, JSON.stringify({ main: entry, output: blob, disableExperimentalSEAWarning: true, assets: { 'workflow-runtime.cjs': runtimePath } }));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'pipe' });
  copyFileSync(process.execPath, binary);
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/postject/dist/cli.js', import.meta.url)), binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'pipe' });
  assert.equal(execFileSync(binary, [], { cwd: tmpdir(), encoding: 'utf8' }).trim(), '12');
});

test('large shell output survives transport, TypeScript downstream input and file IO', async () => {
  const ctx = context('');
  ctx.step = { id: 'a', name: 'Large shell', kind: 'shell', command: 'printf "%0250000d" 0; printf "%0150000d" 0 >&2' };
  const output = await local.shell.execute(ctx) as { stdout: string; stderr: string; exitCode: number };
  assert.equal(output.stdout.length, 250000);
  assert.equal(output.stderr.length, 150000);
  const downstream = context('await fs.writeText("large-output", input); return await fs.readText("large-output");', { type: 'string' });
  downstream.input = output.stdout;
  downstream.inputSchema = { type: 'string' };
  assert.equal(await local.typescript.execute(downstream), output.stdout);
});
