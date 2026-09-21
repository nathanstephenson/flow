import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { packageName, privatePath, type Installation, type Lease, type UpdateTransaction } from './install-guard.ts';
import { readHost, type HostIdentity } from '../daemon/ownership.ts';
import { backgroundHostArgs, getHostStatus, HostRefusal, launchBackground, processAlive, requestHostStop, requireRestartable, waitUntil } from './host-control.ts';
import { InstallationProcessUncertain, replacePackage } from './install-process.ts';

export function npmExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory, 'npm');
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch {}
  }
  throw new Error('npm was not found in PATH');
}
function npmPath(npm: string, command: string): string {
  return realpathSync(execFileSync(npm, [command, '--global'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim());
}
export function packageVersion(slot: string): string {
  privatePath(slot);
  const metadata = JSON.parse(readFileSync(join(slot, 'package.json'), 'utf8'));
  if (metadata?.name !== packageName || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) throw new Error('Installed package identity is invalid');
  return metadata.version;
}
async function verify(install: Installation, transaction: UpdateTransaction, expected?: string): Promise<string> {
  const version = packageVersion(install.slot);
  if (expected && version !== expected) throw new Error('Installed package verification failed');
  if (!readFileSync(join(install.slot, 'dist/build-id'), 'utf8').trim()) throw new Error('Installed build identity is missing');
  const env = await transaction.authorizeVerification();
  const reported = execFileSync(process.execPath, [join(install.slot, 'dist/cli/bootstrap.js'), '--version'], { env, encoding: 'utf8', timeout: 15000 }).trim();
  if (reported !== version) throw new Error('Fresh Flow process reports the wrong version');
  await transaction.assertAuthorizationConsumed();
  return version;
}
async function restore(install: Installation, transaction: UpdateTransaction, root: string, host: HostIdentity, version: string): Promise<void> {
  const env = await transaction.authorizeRestoration(backgroundHostArgs(host.settings));
  await launchBackground({
    root, settings: host.settings, entry: [join(install.slot, 'dist/cli/bootstrap.js')], env,
    validate(status) {
      if (status.instanceId === host.instanceId || status.version !== version || status.mode !== 'background' ||
          (['port', 'address', 'cwd', 'oidc'] as const).some(key => status.settings[key] !== host.settings[key])) {
        throw new Error('Restored Session Host settings or version differ');
      }
    },
  });
  await transaction.assertAuthorizationConsumed();
}

export type UpdateResult = { previousVersion: string; installedVersion: string; changed: boolean };

/** Reused by the web surface for an explanation; `update` repeats it immediately before mutation. */
export function inspectUpdateInstallation(install: Installation): { npm: string; version: string } {
  const npm = npmExecutable();
  const prefix = npmPath(npm, 'prefix'), root = npmPath(npm, 'root');
  if (prefix !== install.prefix || root !== join(prefix, 'lib/node_modules') || realpathSync(join(root, packageName)) !== install.slot) throw new Error('npm selects a different installation. Put the matching npm in PATH and select its prefix.');
  return { npm, version: packageVersion(install.slot) };
}

export async function update(install: Installation, lease: Lease, args: string[]): Promise<UpdateResult> {
  if (args.length > 2 || args[0] !== 'update' || (args.length === 2 && args[1] !== '--force')) throw new Error('usage: flow update [--force]');
  const inspected = inspectUpdateInstallation(install);
  const npm = inspected.npm;
  const prefix = install.prefix;
  const previous = inspected.version;
  let host = readHost(lease.root);
  if (host && processAlive(host.pid)) {
    const status = await getHostStatus(host);
    requireRestartable(status);
    host = { ...host, ...status };
  } else host = undefined;
  const transaction = await install.beginUpdate(lease, previous, host);
  let needsRestoration = false, replacing = false;
  const repair = () => `Flow startup remains blocked by ${install.barrierPath}. Stop all Flow and npm processes for this prefix. Reinstall ${packageName}@${previous} with the matching npm and prefix ${JSON.stringify(prefix)}. Verify the package files manually, then remove ${install.barrierPath} and start the Session Host again.`;
  async function replace(version: string, expected?: string): Promise<string> {
    await transaction.beginReplacement();
    replacing = true;
    await replacePackage(npm, prefix, `${packageName}@${version}`);
    const installed = await verify(install, transaction, expected);
    if (host && needsRestoration) {
      await restore(install, transaction, lease.root, host, installed);
      needsRestoration = false;
    }
    await transaction.complete();
    return installed;
  }
  try {
    if (host) {
      needsRestoration = true;
      try { await requestHostStop(host, args.includes('--force')); }
      catch (error) { if (error instanceof HostRefusal) needsRestoration = false; throw error; }
      const pid = host.pid;
      await waitUntil(async () => !processAlive(pid), 'Session Host process did not exit; installation was not changed');
    }
    const version = await replace('latest');
    console.log(version === previous ? `Flow is already at ${version}.` : `Flow updated: ${previous} → ${version}`);
    return { previousVersion: previous, installedVersion: version, changed: version !== previous };
  } catch (error) {
    if (error instanceof InstallationProcessUncertain) throw new Error(`${String(error)}. ${repair()}`);
    if (!replacing) {
      if (needsRestoration && host && processAlive(host.pid)) throw new Error(`${String(error)}. No package files were changed; wait for the stopping host to exit. ${repair()}`);
      if (needsRestoration && host) {
        try { await restore(install, transaction, lease.root, host, previous); }
        catch (failure) { throw new Error(`${String(error)}; restoration failed: ${String(failure)}. ${repair()}`); }
      }
      await transaction.complete();
      throw error;
    }
    try { await replace(previous, previous); }
    catch (failure) { throw new Error(`Update failed: ${String(error)}; recovery failed: ${String(failure)}. ${repair()}`); }
    throw new Error(`Update failed: ${String(error)}. Reinstalled and verified ${previous}; the previous files were not preserved.`);
  }
}
