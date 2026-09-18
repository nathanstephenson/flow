import { execFileSync, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fchmodSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, json, packageName, privatePath, type Barrier, type Installation, type Lease } from './install-guard.ts';

type Host = { instanceId: string; pid: number; version: string; url: string; token: string; mode: string; settings: { port: number; address: string; cwd: string; oidc: string } };
function npmExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory, 'npm');
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch {}
  }
  throw new Error('npm was not found in PATH');
}
function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).trim();
}
function fingerprint(): string {
  return createHash('sha256').update(JSON.stringify(['ISSUER', 'CLIENT_ID', 'CLIENT_SECRET', 'PUBLIC_APP_URL'].map(key => process.env[`FLOW_OIDC_${key}`]?.trim() ?? ''))).digest('hex');
}
async function request(host: Host, stop?: boolean, force = false): Promise<Host> {
  const response = await fetch(`${host.url}/api/host${stop ? '/stop' : ''}`, {
    method: stop ? 'POST' : 'GET', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    ...(stop ? { body: JSON.stringify({ instanceId: host.instanceId, force }) } : {}), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Object.assign(new Error(`Session Host refused: ${await response.text()}`), { hostRefused: true });
  if (stop) return host;
  const status = await response.json() as Host;
  if (status.instanceId !== host.instanceId || status.pid !== host.pid) throw new Error('Session Host identity changed');
  return { ...status, token: host.token };
}
async function wait(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
export async function update(install: Installation, lease: Lease, args: string[]): Promise<void> {
  if (args.length > 2 || args[0] !== 'update' || (args.length === 2 && args[1] !== '--force')) throw new Error('usage: flow update [--force]');
  const npm = npmExecutable();
  const prefix = realpathSync(run(npm, ['prefix', '--global']));
  const root = realpathSync(run(npm, ['root', '--global']));
  if (prefix !== install.prefix || root !== join(prefix, 'lib/node_modules') || realpathSync(join(root, packageName)) !== install.slot) throw new Error('npm selects a different installation. Put the matching npm in PATH and select its prefix.');
  privatePath(install.slot);
  const metadata = json<{ name: string; version: string }>(join(install.slot, 'package.json'));
  if (metadata?.name !== packageName || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) throw new Error('Installed package identity is invalid');
  let host = json<Host>(join(lease.root, 'daemon.json'));
  if (host && alive(host.pid)) {
    host = await request(host);
    if (host.mode !== 'background') throw new Error('Self-update cannot stop a foreground or embedded Session Host');
    if (host.settings.oidc !== fingerprint()) throw new Error('Update requires matching OIDC configuration');
    if (!statSync(host.settings.cwd).isDirectory()) throw new Error('Saved working directory is unavailable');
  } else host = undefined;
  const barrier: Barrier = { pid: process.pid, id: randomUUID(), phase: 'preparing', previous: metadata.version };
  await install.locked(() => {
    if (json(install.barrierPath)) throw new Error(`Update already blocked: ${install.barrierPath}`);
    const leases = install.leases();
    if (leases.some(other => other.id !== lease.id && !(host && other.pid === host.pid && other.root === lease.root && other.args.includes('--background-host')))) throw new Error('Stop all other Flow hosts and CLI/TUI clients using this installation first');
    if (host && !leases.some(other => other.pid === host.pid && other.root === lease.root)) throw new Error('Stop all pre-guard Flow processes before updating');
    install.save(barrier);
  });
  const entry = join(install.slot, 'dist/cli/bootstrap.js');
  let stopped = false, replacing = false;
  async function capability(command: string[]) {
    const token = randomUUID();
    await install.locked(() => {
      barrier.capability = { token, root: lease.root, args: command };
      install.save(barrier);
    });
    return { ...process.env, FLOW_STATE_DIR: lease.root, FLOW_UPDATE_CAPABILITY: token };
  }
  async function verify(expected?: string): Promise<string> {
    privatePath(install.slot);
    const fresh = json<{ name: string; version: string }>(join(install.slot, 'package.json'));
    if (fresh?.name !== packageName || !fresh.version || (expected && fresh.version !== expected)) throw new Error('Installed package verification failed');
    if (!readFileSync(join(install.slot, 'dist/build-id'), 'utf8').trim()) throw new Error('Installed build identity is missing');
    const env = await capability(['--version']);
    const version = execFileSync(process.execPath, [entry, '--version'], { env, encoding: 'utf8', timeout: 15000 }).trim();
    if (version !== fresh.version) throw new Error('Fresh Flow process reports the wrong version');
    await install.locked(() => { if (json<Barrier>(install.barrierPath)?.capability) throw new Error('Fresh Flow did not use the installation guard'); });
    return version;
  }
  async function restore(version: string) {
    if (!host || !stopped) return;
    barrier.phase = 'restoring';
    const command = ['serve', '--background-host', '--port', String(host.settings.port), '--address', host.settings.address];
    const env = await capability(command);
    const log = openSync(join(lease.root, 'host.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let child;
    try {
      fchmodSync(log, 0o600);
      child = spawn(process.execPath, [entry, ...command], { env, cwd: host.settings.cwd, detached: true, stdio: ['ignore', log, log] });
    } finally { closeSync(log); }
    let failure: Error | undefined;
    child.on('error', error => { failure = error; });
    child.on('exit', code => { failure = new Error(`Restored Session Host exited (${code})`); });
    child.unref();
    try {
      await wait(async () => {
        if (failure) throw failure;
        const fresh = json<Host>(join(lease.root, 'daemon.json'));
        if (!fresh || fresh.pid !== child.pid || fresh.instanceId === host!.instanceId) return false;
        const status = await request(fresh);
        if (status.version !== version || status.mode !== 'background' || (['port', 'address', 'cwd', 'oidc'] as const).some(key => status.settings[key] !== host!.settings[key])) throw new Error('Restored Session Host settings or version differ');
        return true;
      }, 'Session Host restoration timed out');
      stopped = false;
    } catch (error) {
      child.kill('SIGTERM');
      if (child.pid) await wait(async () => !alive(child.pid!), 'Failed Session Host did not exit');
      throw error;
    }
  }
  const repair = () => `Flow startup remains blocked by ${install.barrierPath}. Stop all Flow and npm processes for this prefix. Repair with: ${npm} install --global --prefix ${JSON.stringify(prefix)} ${packageName}@${metadata.version}. Verify the package files manually, then remove ${install.barrierPath} and start the Session Host again.`;
  try {
    if (host) {
      stopped = true;
      try { await request(host, true, args.includes('--force')); }
      catch (error) { if ((error as { hostRefused?: boolean }).hostRefused) stopped = false; throw error; }
      await wait(async () => !alive(host!.pid), 'Session Host process did not exit; installation was not changed');
      await install.locked(() => { if (install.leases().some(other => other.id !== lease.id)) throw new Error('Other Flow processes remain'); });
    }
    barrier.phase = 'replacing';
    await install.locked(() => install.save(barrier));
    replacing = true;
    execFileSync(npm, ['install', '--global', '--prefix', prefix, `${packageName}@latest`], { stdio: 'inherit' });
    const version = await verify();
    await restore(version);
    await install.locked(() => install.clear());
    console.log(version === metadata.version ? `Flow is already at ${version}.` : `Flow updated: ${metadata.version} → ${version}`);
  } catch (error) {
    if (!replacing) {
      if (stopped && host && alive(host.pid)) throw new Error(`${String(error)}. No package files were changed; wait for the stopping host to exit. ${repair()}`);
      if (stopped && host) {
        try { await restore(metadata.version); } catch (failure) { throw new Error(`${String(error)}; restoration failed: ${String(failure)}. ${repair()}`); }
      }
      await install.locked(() => install.clear());
      throw error;
    }
    try {
      barrier.phase = 'replacing';
      await install.locked(() => {
        if (install.leases().some(other => other.id !== lease.id)) throw new Error('A Flow process remains; rollback cannot run safely');
        delete barrier.capability;
        install.save(barrier);
      });
      execFileSync(npm, ['install', '--global', '--prefix', prefix, `${packageName}@${metadata.version}`], { stdio: 'inherit' });
      await verify(metadata.version);
      await restore(metadata.version);
      await install.locked(() => install.clear());
    } catch (failure) { throw new Error(`Update failed: ${String(error)}; recovery failed: ${String(failure)}. ${repair()}`); }
    throw new Error(`Update failed: ${String(error)}. Reinstalled and verified ${metadata.version}; the previous files were not preserved.`);
  }
}
