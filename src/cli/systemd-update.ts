import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getHostStatus, waitUntil } from './host-control.ts';
import { readHost, type HostIdentity } from '../daemon/ownership.ts';
import type { UpdateTransaction } from './install-guard.ts';

const exec = promisify(execFile);
export type SystemdUpdate = { scope: 'system' | 'user'; service: string; updater: string; hostArgs: string[] };
export function parseSystemdUpdate(value: unknown): SystemdUpdate {
  const c = value as SystemdUpdate;
  const unit = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(v);
  if (!c || !['system', 'user'].includes(c.scope) || !unit(c.service) || !unit(c.updater) || c.service === c.updater ||
      !Array.isArray(c.hostArgs) || c.hostArgs[0] !== 'serve' || c.hostArgs.some(a => typeof a !== 'string') || c.hostArgs.includes('--background-host') || c.hostArgs.includes('start')) {
    throw new Error('Invalid systemd-update.json: use distinct fixed service units and foreground serve arguments');
  }
  return c;
}
export function systemdUpdate(root: string): SystemdUpdate | undefined {
  try { return parseSystemdUpdate(JSON.parse(readFileSync(join(root, 'systemd-update.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export class SystemdCommandFailed extends Error {
  readonly completed: boolean;
  constructor(error: unknown) {
    super(String(error), { cause: error });
    const command = error as { code?: unknown; killed?: boolean; signal?: unknown };
    this.completed = typeof command.code === 'number' && !command.killed && !command.signal;
  }
}
export async function systemctl(c: SystemdUpdate, action: 'start' | 'stop' | 'show', unit: string, extra: string[] = []): Promise<string> {
  try {
    const { stdout } = await exec('/usr/bin/systemctl', [`--${c.scope}`, '--no-ask-password', action, unit, ...extra], { timeout: 60000 });
    return stdout.trim();
  } catch (error) { throw new SystemdCommandFailed(error); }
}

/** Undo admission-only quiescence after a definite manager refusal, never an uncertain stop. */
export async function resumeSystemdAdmission(c: SystemdUpdate, host: HostIdentity): Promise<void> {
  await assertSystemdOwner(c, c.service, host.pid);
  if (await systemctl(c, 'show', c.service, ['--property=ActiveState', '--value']) !== 'active' ||
      await systemctl(c, 'show', c.service, ['--property=Job', '--value']) !== '') {
    throw new Error('The original systemd service is not active and job-free; admission cannot safely resume');
  }
  const response = await fetch(`${host.url}/api/host/stop`, {
    method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: host.instanceId, resume: true }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Cannot resume Session Host admission: ${await response.text()}`);
}
export async function assertSystemdOwner(c: SystemdUpdate, unit: string, pid: number): Promise<void> {
  if (await systemctl(c, 'show', unit, ['--property=MainPID', '--value']) !== String(pid)) throw new Error(`systemd ${unit} does not own the expected process`);
}
export class SystemdLaunchUncertain extends Error {}
export type SystemdRequest = { id?: string; version?: string; force: boolean };
const requestPath = (root: string) => join(root, 'systemd-update-request.json');
export async function launchSystemdUpdate(root: string, c: SystemdUpdate, request: SystemdRequest): Promise<void> {
  // A worker removes its request just before exiting. Starting an already-active oneshot is a
  // no-op, so do not enqueue another request in that window (or while a unit is deactivating).
  const state = await systemctl(c, 'show', c.updater, ['--property=ActiveState', '--value']);
  if (!['inactive', 'failed'].includes(state)) throw new Error(`Systemd updater ${c.updater} is ${state || 'unknown'}; wait for it to stop before updating`);
  // Exclusive durable request also serializes CLI and web launchers. Never overwrite an uncertain job.
  writeFileSync(requestPath(root), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  // --no-block: Type=oneshot must not wait for the update to finish (and kill this launcher).
  // On an ambiguous systemctl failure retain the request for inspection, not automatic retry.
  try { await systemctl(c, 'start', c.updater, ['--no-block']); }
  catch (error) {
    throw new SystemdLaunchUncertain(`Could not confirm systemd update submission: ${String(error)}. Inspect ${c.updater} and ${requestPath(root)} before retrying; the request has been retained.`);
  }
}
export function readSystemdRequest(root: string): SystemdRequest {
  const r = JSON.parse(readFileSync(requestPath(root), 'utf8')) as SystemdRequest;
  if (!r || typeof r.force !== 'boolean' || (r.id !== undefined && !/^[a-f0-9-]{36}$/.test(r.id)) ||
      (r.version !== undefined && (typeof r.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(r.version))) || ((r.id === undefined) !== (r.version === undefined))) throw new Error('Invalid systemd update request');
  return r;
}
export function clearSystemdRequest(root: string): void { unlinkSync(requestPath(root)); }
export function systemdCapability(root: string): string | undefined {
  if (process.env.FLOW_SYSTEMD_HOST !== '1') return undefined;
  try { return readFileSync(join(root, 'systemd-update-capability'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function restoreSystemd(root: string, c: SystemdUpdate, transaction: UpdateTransaction, old: HostIdentity, version: string): Promise<void> {
  const env = await transaction.authorizeRestoration(c.hostArgs);
  const path = join(root, 'systemd-update-capability');
  writeFileSync(path, env.FLOW_UPDATE_CAPABILITY!, { flag: 'wx', mode: 0o600 });
  try {
    await systemctl(c, 'start', c.service);
    await waitUntil(async () => {
      const host = readHost(root);
      if (!host || host.instanceId === old.instanceId) return false;
      await assertSystemdOwner(c, c.service, host.pid);
      const status = await getHostStatus(host);
      if (status.version !== version || status.mode !== 'foreground' ||
          (['port', 'address', 'cwd', 'oidc'] as const).some(k => status.settings[k] !== old.settings[k])) throw new Error('Restored systemd Session Host settings or version differ');
      return true;
    }, 'systemd Session Host startup timed out');
    await transaction.assertAuthorizationConsumed();
  } catch (error) {
    // Stop a failed restoration before rollback touches package files.
    await systemctl(c, 'stop', c.service);
    throw error;
  } finally { unlinkSync(path); }
}
