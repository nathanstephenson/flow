import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validSecretName } from '../protocol/secrets.ts';

export class SecretStore {
  private readonly directory: string;

  constructor(stateRoot: string) {
    this.directory = join(stateRoot, 'secrets');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  list(): string[] {
    return readdirSync(this.directory).filter(name => name.endsWith('.secret'))
      .map(name => name.slice(0, -7)).filter(validSecretName).sort();
  }

  has(name: string): boolean { return existsSync(this.path(name)); }

  set(name: string, value: string): void {
    const target = this.path(name);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 64_000 || value.length === 0) throw new Error('Invalid secret value');
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, target);
      this.sync();
    } finally { rmSync(temporary, { force: true }); }
  }

  delete(name: string): void {
    rmSync(this.path(name), { force: true });
    this.sync();
  }

  resolve(name: string, signal?: AbortSignal): string {
    signal?.throwIfAborted();
    try { return readFileSync(this.path(name), 'utf8'); }
    catch { throw new Error('Secret unavailable'); }
  }

  private path(name: string): string {
    if (!validSecretName(name)) throw new Error('Invalid secret name');
    return join(this.directory, `${name}.secret`);
  }

  private sync(): void {
    const fd = openSync(this.directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
