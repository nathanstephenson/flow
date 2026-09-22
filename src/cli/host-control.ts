import { spawn } from 'node:child_process';
import { closeSync, constants, fchmodSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { oidcFingerprint, readHost, type HostIdentity, type HostStatus } from '../daemon/ownership.ts';

export class HostRefusal extends Error {}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process owner');
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function getHostStatus(host: HostIdentity): Promise<HostStatus> {
  const response = await fetch(`${host.url}/api/host`, {
    headers: { authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new HostRefusal(`Session Host refused: ${await response.text()}`);
  const status = await response.json() as HostStatus;
  if (status.instanceId !== host.instanceId || status.pid !== host.pid) throw new Error('Session Host identity changed');
  return status;
}

export async function requestHostStop(host: HostIdentity, force: boolean, quiesce = false): Promise<void> {
  const response = await fetch(`${host.url}/api/host/stop`, {
    method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: host.instanceId, force, quiesce }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new HostRefusal(`Session Host refused: ${await response.text()}`);
}

export function requireRestartable(host: HostStatus): void {
  if (host.mode !== 'background') throw new Error('Only a background-owned Session Host can restart');
  if (host.settings.oidc !== oidcFingerprint()) throw new Error('Restart requires matching OIDC configuration');
  if (!statSync(host.settings.cwd).isDirectory()) throw new Error('Saved working directory is unavailable');
}

export async function waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

export function backgroundHostArgs(settings: HostIdentity['settings']): string[] {
  return ['serve', '--background-host', '--port', String(settings.port), '--address', settings.address];
}

export async function launchBackground(options: {
  root: string;
  settings: HostIdentity['settings'];
  entry: string[];
  env: NodeJS.ProcessEnv;
  validate?: (status: HostStatus) => void;
}): Promise<HostIdentity> {
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const root = realpathSync(options.root);
  const logPath = join(root, 'host.log');
  const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    fchmodSync(log, 0o600);
    child = spawn(process.execPath, [...options.entry, ...backgroundHostArgs(options.settings)], {
      cwd: options.settings.cwd, detached: true, stdio: ['ignore', log, log], env: { ...options.env, FLOW_STATE_DIR: root },
    });
  } finally { closeSync(log); }
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  child.on('exit', code => { failure = new Error(`Session Host startup failed (${code})`); });
  child.unref();
  let started: HostIdentity | undefined;
  try {
    await waitUntil(async () => {
      if (failure) throw failure;
      const identity = readHost(root);
      if (!identity || identity.pid !== child.pid) return false;
      const status = await getHostStatus(identity);
      options.validate?.(status);
      started = { ...identity, ...status };
      return true;
    }, 'Session Host startup timed out');
  } catch (error) {
    child.kill('SIGTERM');
    if (child.pid) await waitUntil(async () => !processAlive(child.pid!), `Session Host did not exit; see ${logPath}`);
    throw new Error(`${String(error)}; see ${logPath}`);
  }
  return started!;
}
