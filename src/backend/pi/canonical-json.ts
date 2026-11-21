import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeFileSync, type Stats } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PiCanonicalJson {
  private readonly path: string;
  private readonly name: 'auth.json' | 'models-store.json';
  constructor(path: string, name: 'auth.json' | 'models-store.json') { this.path = path; this.name = name; }

  private check(stat: Stats): void {
    if (!stat.isFile() || (this.name === 'models-store.json' && stat.nlink !== 1)) {
      throw new Error(this.name === 'auth.json' ? 'Pi auth.json must be a regular file, not a symbolic link'
        : 'Pi models-store.json must be a regular file, not a symbolic or hard link');
    }
    if (this.name === 'models-store.json' && stat.size > 16 * 1024 * 1024) {
      throw new Error('Pi models-store.json exceeds the catalog size limit');
    }
  }

  private exists(): boolean {
    try {
      this.check(lstatSync(this.path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private open(flags: number): number {
    this.exists();
    const fd = openSync(this.path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try { this.check(fstatSync(fd)); }
    catch (error) { closeSync(fd); throw error; }
    return fd;
  }

  private readRaw(): Record<string, unknown> {
    if (!this.exists()) return {};
    const fd = this.open(constants.O_RDONLY);
    try {
      let raw: unknown;
      try {
        const content = readFileSync(fd, 'utf8').replace(/^\uFEFF/, '');
        raw = this.name === 'models-store.json' && !content ? {} : JSON.parse(content);
      } catch { throw new Error(`Invalid Pi ${this.name}: expected valid JSON`); }
      if (!object(raw)) throw new Error(`Invalid Pi ${this.name}: expected an object`);
      return raw;
    } finally { closeSync(fd); }
  }

  protected writeRaw(raw: Record<string, unknown>): void {
    const create = this.name === 'models-store.json' && !this.exists();
    const content = JSON.stringify(raw, null, 2);
    if (this.name === 'models-store.json' && Buffer.byteLength(content) > 16 * 1024 * 1024) {
      throw new Error('Pi models-store.json exceeds the catalog size limit');
    }
    const fd = this.open(constants.O_WRONLY | (create ? constants.O_CREAT | constants.O_EXCL : 0));
    try {
      ftruncateSync(fd, 0);
      writeFileSync(fd, content, { encoding: 'utf8', mode: 0o600 });
    } finally { closeSync(fd); }
  }

  protected async locked<T>(fn: (raw: Record<string, unknown>, assertLock: () => void) => Promise<T> | T,
    signal?: AbortSignal, create = false): Promise<T> {
    signal?.throwIfAborted();
    if (!this.exists() && !create) return fn({}, () => {});
    const deadline = Date.now() + 30_000;
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    const assertLock = () => { if (compromised) throw compromised; };
    for (let attempt = 0; !release; attempt++) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.path, {
          realpath: false, stale: 30_000, retries: 0,
          onCompromised: error => { compromised = error; },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error;
        await sleep(Math.min(10 * 2 ** Math.min(attempt, 7), 1000, deadline - Date.now()), undefined, signal ? { signal } : {});
      }
    }
    try {
      assertLock();
      signal?.throwIfAborted();
      return await fn(this.readRaw(), assertLock);
    } finally {
      try { await release(); } catch (error) { if (!compromised) throw error; }
    }
  }

  raw(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.locked(raw => raw, signal);
  }
}
