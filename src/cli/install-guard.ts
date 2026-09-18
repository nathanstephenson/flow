import { mkdirSync, realpathSync, lstatSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const packageName = '@nathanstephenson/flow';
export type Owner = { pid: number; id: string };
export type Lease = Owner & { root: string; args: string[] };
export type Barrier = Owner & { phase: 'preparing' | 'replacing' | 'restoring'; previous: string; capability?: { token: string; root: string; args: string[] } };
export function json<T>(path: string): T | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid JSON record: ${path}`);
    return value as T;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid installation process owner');
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export function privatePath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error(`Not a user-owned, private installation path: ${path}`);
}
export function updateEligible(slot: string): boolean {
  slot = resolve(slot);
  const prefix = resolve(slot, '../../../..');
  if (slot !== join(prefix, 'lib/node_modules', packageName) || process.getuid?.() === 0) return false;
  for (const path of [prefix, join(prefix, 'lib'), join(prefix, 'lib/node_modules'), join(prefix, 'lib/node_modules/@nathanstephenson'), slot]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return false;
  }
  return realpathSync(prefix) === prefix;
}
export function installation(slot: string) {
  slot = resolve(slot);
  const prefix = resolve(slot, '../../../..');
  if (!updateEligible(slot)) throw new Error('Self-update requires a user-owned, non-root private installation in a canonical global npm prefix (not source, npm link, or SEA); update this installation manually with npm');
  const base = join(prefix, '.flow-installations');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  privatePath(base);
  const directory = join(base, createHash('sha256').update(slot).digest('hex').slice(0, 24));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory);
  if ((lstatSync(base).mode & 0o077) || (lstatSync(directory).mode & 0o077)) throw new Error('Installation registry must have mode 0700');
  const removeOwner = (path: string, filename: string) => {
    try { unlinkSync(join(path, filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { rmdirSync(path); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  };
  async function locked<T>(action: () => T): Promise<T> {
    const owner = { pid: process.pid, id: randomUUID() };
    const filename = `${owner.id}.json`;
    const candidate = join(directory, `mutex-${owner.id}`), lock = join(directory, 'mutex');
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, filename), JSON.stringify(owner), { mode: 0o600 });
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
            const held = json<Owner>(join(lock, entries[0]!));
            if (held) {
              if (`${held.id}.json` !== entries[0]) throw new Error('Invalid installation registry owner');
              if (!alive(held.pid)) removeOwner(lock, entries[0]!);
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
      const path = join(directory, name), lease = json<Lease>(path);
      if (!lease) return [];
      if (typeof lease.id !== 'string' || name !== `lease-${lease.id}.json` || !Array.isArray(lease.args) || typeof lease.root !== 'string') throw new Error('Invalid installation lease');
      if (alive(lease.pid)) return [lease];
      unlinkSync(path);
      return [];
    });
  }
  async function register(build: string, root: string, args: string[], capability?: string) {
    return locked(() => {
      const barrier = json<Barrier>(barrierPath);
      if (barrier) {
        const allowed = barrier.capability;
        if (!alive(barrier.pid) || !allowed || !capability || allowed.token !== capability || allowed.root !== root || JSON.stringify(allowed.args) !== JSON.stringify(args)) throw new Error(`Flow startup blocked by ${barrierPath}. An update is active or needs manual repair; see README, Updating Flow.`);
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
  return { slot, prefix, directory, barrierPath, locked, save, leases, register, clear() { unlinkSync(barrierPath); } };
}
export type Installation = ReturnType<typeof installation>;
