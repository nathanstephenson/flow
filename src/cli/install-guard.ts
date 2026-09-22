import { mkdirSync, realpathSync, lstatSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive } from './host-control.ts';

export const packageName = '@nathanstephenson/flow';
export type UpdateUnsupportedKind = 'source' | 'npm-link' | 'sea' | 'shared' | 'system' | 'root';
type Owner = { pid: number; id: string };
export type Lease = Owner & { root: string; args: string[] };
export type Barrier = Owner & { phase: 'preparing' | 'replacing' | 'restoring'; previous: string; capability?: { token: string; root: string; args: string[] } };

function record(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid registry record: ${path}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function owner(value: Record<string, unknown>): Owner {
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.id)) throw new Error('Invalid installation owner');
  return { pid: value.pid, id: value.id };
}
function argumentsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(arg => typeof arg === 'string')) throw new Error('Invalid installation arguments');
  return value;
}
function readBarrier(path: string): Barrier | undefined {
  const value = record(path);
  if (!value) return undefined;
  if (!['preparing', 'replacing', 'restoring'].includes(String(value.phase)) || typeof value.previous !== 'string') throw new Error('Invalid update barrier');
  const result: Barrier = { ...owner(value), phase: value.phase as Barrier['phase'], previous: value.previous };
  if (value.capability !== undefined) {
    const capability = value.capability as Record<string, unknown> | null;
    if (!capability || typeof capability.token !== 'string' || typeof capability.root !== 'string' || !isAbsolute(capability.root)) throw new Error('Invalid update authorization');
    result.capability = { token: capability.token, root: capability.root, args: argumentsOf(capability.args) };
  }
  return result;
}
export function canonicalRoot(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try { return join(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error;
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}
export function privatePath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error(`Not a user-owned, private installation path: ${path}`);
}
function registryPath(slot: string): string {
  return join(resolve(slot, '../../../..'), '.flow-installations', createHash('sha256').update(resolve(slot)).digest('hex').slice(0, 24));
}
export function registryExists(slot: string): boolean {
  try { lstatSync(registryPath(slot)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function updateIneligibility(slot: string, uid = process.getuid?.()): Exclude<UpdateUnsupportedKind, 'sea'> | undefined {
  slot = resolve(slot);
  const prefix = resolve(slot, '../../../..');
  if (slot !== join(prefix, 'lib/node_modules', packageName)) return 'source';
  if (uid === undefined || uid === 0) return 'root';
  for (const path of [prefix, join(prefix, 'lib'), join(prefix, 'lib/node_modules'), join(prefix, 'lib/node_modules/@nathanstephenson'), slot]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'npm-link';
    if (stat.uid !== uid) return 'system';
    if ((stat.mode & 0o022) !== 0) return 'shared';
  }
  for (let path = dirname(prefix); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'npm-link';
    if (stat.uid !== 0 && stat.uid !== uid) return 'system';
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) return 'shared';
    if (dirname(path) === path) break;
  }
  return realpathSync(prefix) === prefix ? undefined : 'npm-link';
}

function pathHasSymlink(path: string): boolean {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) return false;
  }
}

export function updateUnsupportedReason(kind: UpdateUnsupportedKind): string {
  return {
    source: 'A source checkout cannot update itself. Install or update Flow through a private global npm prefix.',
    'npm-link': 'An npm-linked Flow checkout cannot update itself. Remove the link and install Flow in a private global npm prefix.',
    sea: 'Single-executable Flow builds cannot update themselves. Install the new binary manually.',
    shared: 'A shared or group/other-writable global npm installation cannot update itself. Use a private, user-owned npm prefix without sudo.',
    system: 'A system-owned or another user\'s global npm installation cannot update itself. Install Flow in your own private npm prefix without sudo.',
    root: 'A root-owned or sudo-installed Flow cannot update itself. Install Flow as your normal user in a private npm prefix.',
  }[kind];
}

/** Explain why this process cannot expose web self-update without mislabelling global installs as source. */
export function explainUnsupportedUpdate(slot: string, entry = process.argv[1], uid = process.getuid?.()): string {
  let kind = updateIneligibility(slot, uid) ?? 'source';
  if (kind === 'source' && entry && pathHasSymlink(entry)) kind = 'npm-link';
  return updateUnsupportedReason(kind);
}

export function updateEligible(slot: string): boolean {
  return updateIneligibility(slot) === undefined;
}
export function installation(slot: string) {
  slot = resolve(slot);
  const prefix = resolve(slot, '../../../..');
  if (!updateEligible(slot)) throw new Error('Self-update requires a user-owned, non-root private installation in a canonical global npm prefix. Guarded startup cannot continue after permissions change; repair the installation or update it manually with npm.');
  const directory = registryPath(slot), base = dirname(directory);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  privatePath(base);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory);
  if ((lstatSync(base).mode & 0o077) || (lstatSync(directory).mode & 0o077)) throw new Error('Installation registry must have mode 0700');
  const removeOwner = (path: string, filename: string) => {
    try { unlinkSync(join(path, filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { rmdirSync(path); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  };
  async function locked<T>(action: () => T): Promise<T> {
    const ownerId = randomUUID(), filename = `${ownerId}.json`;
    const candidate = join(directory, `mutex-${ownerId}`), lock = join(directory, 'mutex');
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, filename), JSON.stringify({ pid: process.pid, id: ownerId }), { mode: 0o600 });
    let acquired = false;
    try {
      for (let attempt = 0; !acquired; attempt++) {
        try { renameSync(candidate, lock); acquired = true; }
        catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          if (attempt >= 100) throw new Error('Installation registry is busy');
          let entries: string[];
          try { entries = readdirSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          if (entries.length) {
            if (entries.length !== 1 || !/^[a-f0-9-]+\.json$/.test(entries[0]!)) throw new Error('Invalid installation registry owner');
            const value = record(join(lock, entries[0]!));
            if (value) {
              const held = owner(value);
              if (`${held.id}.json` !== entries[0]) throw new Error('Invalid installation registry owner');
              if (!processAlive(held.pid)) removeOwner(lock, entries[0]!);
            }
          }
          await delay(25);
        }
      }
      return action();
    } finally { removeOwner(acquired ? lock : candidate, filename); }
  }
  const barrierPath = join(directory, 'update.json');
  function save(barrier: Barrier) {
    const temporary = join(directory, `update-${barrier.id}.json`);
    writeFileSync(temporary, JSON.stringify(barrier), { mode: 0o600 });
    renameSync(temporary, barrierPath);
  }
  function leases(): Lease[] {
    return readdirSync(directory).filter(name => name.startsWith('lease-')).flatMap(name => {
      const path = join(directory, name), value = record(path);
      if (!value) return [];
      const held = owner(value);
      if (name !== `lease-${held.id}.json` || typeof value.root !== 'string' || !isAbsolute(value.root)) throw new Error('Invalid installation lease');
      const lease: Lease = { ...held, root: canonicalRoot(value.root), args: argumentsOf(value.args) };
      if (processAlive(lease.pid)) return [lease];
      unlinkSync(path);
      return [];
    });
  }
  async function register(build: string, root: string, args: string[], capability?: string) {
    root = canonicalRoot(root);
    return locked(() => {
      const barrier = readBarrier(barrierPath);
      if (barrier) {
        const allowed = barrier.capability;
        if (!processAlive(barrier.pid) || !allowed || !capability || allowed.token !== capability || allowed.root !== root || JSON.stringify(allowed.args) !== JSON.stringify(args)) throw new Error(`Flow startup blocked by ${barrierPath}. An update is active or needs manual repair; see README, Updating Flow.`);
        delete barrier.capability;
        save(barrier);
      }
      if (readFileSync(join(slot, 'dist/build-id'), 'utf8') !== build) throw new Error('Flow was replaced during startup. Run the command again.');
      const lease: Lease = { pid: process.pid, id: randomUUID(), root, args };
      const path = join(directory, `lease-${lease.id}.json`);
      writeFileSync(path, JSON.stringify(lease), { mode: 0o600 });
      return { ...lease, release() { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } };
    });
  }
  async function beginUpdate(lease: Lease, previous: string, host?: { pid: number }, systemdArgs?: string[]) {
    const barrier: Barrier = { pid: process.pid, id: randomUUID(), phase: 'preparing', previous };
    await locked(() => {
      if (readBarrier(barrierPath)) throw new Error(`Update already blocked: ${barrierPath}`);
      const active = leases();
      if (!active.some(other => other.id === lease.id && other.pid === process.pid && other.root === lease.root)) throw new Error('Update process has no installation lease');
      const selected = host && active.find(other => other.pid === host.pid && other.root === lease.root);
      if (systemdArgs && selected && JSON.stringify(selected.args) !== JSON.stringify(systemdArgs)) throw new Error('Configured systemd hostArgs do not match the running Session Host; correct systemd-update.json before updating');
      if (active.some(other => other.id !== lease.id && !(host && other.pid === host.pid && other.root === lease.root && (systemdArgs ? JSON.stringify(other.args) === JSON.stringify(systemdArgs) : other.args.includes('--background-host'))))) throw new Error('Stop all other Flow hosts and CLI/TUI clients using this installation first');
      if (host && !active.some(other => other.pid === host.pid && other.root === lease.root)) throw new Error('Stop all pre-guard Flow processes before updating');
      save(barrier);
    });
    function assertOwner() {
      const current = readBarrier(barrierPath);
      if (current?.id !== barrier.id || current.pid !== process.pid) throw new Error('Update ownership changed; manual repair is required');
    }
    async function authorize(args: string[], phase: Barrier['phase']) {
      const token = randomUUID();
      await locked(() => {
        assertOwner();
        barrier.phase = phase;
        barrier.capability = { token, root: lease.root, args };
        save(barrier);
      });
      return { ...process.env, FLOW_STATE_DIR: lease.root, FLOW_UPDATE_CAPABILITY: token };
    }
    return {
      authorizeVerification: () => authorize(['--version'], 'replacing'),
      authorizeRestoration: (args: string[]) => authorize(args, 'restoring'),
      async assertAuthorizationConsumed() {
        await locked(() => { assertOwner(); if (readBarrier(barrierPath)?.capability) throw new Error('Fresh Flow did not use the installation guard'); });
      },
      async beginReplacement() {
        await locked(() => {
          assertOwner();
          if (leases().some(other => other.id !== lease.id)) throw new Error('A Flow process remains; replacement cannot run safely');
          barrier.phase = 'replacing';
          delete barrier.capability;
          save(barrier);
        });
      },
      async complete() { await locked(() => { assertOwner(); unlinkSync(barrierPath); }); },
    };
  }
  return { slot, prefix, directory, barrierPath, register, beginUpdate };
}
export type Installation = ReturnType<typeof installation>;
export type UpdateTransaction = Awaited<ReturnType<Installation['beginUpdate']>>;
