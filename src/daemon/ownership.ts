import { mkdirSync, realpathSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export type HostIdentity = {
  instanceId: string; pid: number; version: string; url: string; token: string;
  mode: 'foreground' | 'background' | 'embedded';
  settings: { port: number; address: string; cwd: string; oidc: string };
};

export function oidcFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  return createHash('sha256').update(JSON.stringify(['ISSUER', 'CLIENT_ID', 'CLIENT_SECRET', 'PUBLIC_APP_URL'].map(key => env[`FLOW_OIDC_${key}`]?.trim() ?? ''))).digest('hex');
}

export function readHost(root: string): HostIdentity | undefined {
  try { return JSON.parse(readFileSync(join(root, 'daemon.json'), 'utf8')) as HostIdentity; }
  catch { return undefined; }
}

export function acquireHost(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  root = realpathSync(root);
  const instanceId = randomUUID();
  const lock = join(root, 'host.lock');
  const candidate = join(root, `host.lock-${instanceId}`);
  const owner = `${instanceId}.json`;
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, owner), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const remove = (directory: string, filename: string) => {
    try { unlinkSync(join(directory, filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try { renameSync(candidate, lock); break; }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 8) throw error;
        let entries: string[];
        try { entries = readdirSync(lock); } catch { continue; }
        if (entries.length === 0) continue;
        if (entries.length !== 1 || !/^[a-f0-9-]+\.json$/.test(entries[0]!)) throw new Error('Session Host ownership is unknown');
        const filename = entries[0]!;
        let pid: number;
        try { pid = JSON.parse(readFileSync(join(lock, filename), 'utf8')).pid; } catch { continue; }
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Session Host ownership is invalid');
        try { process.kill(pid, 0); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'ESRCH') { remove(lock, filename); continue; }
        }
        throw new Error('A Session Host already owns this state root');
      }
    }
  } catch (error) { remove(candidate, owner); throw error; }
  let released = false;
  return {
    root, instanceId,
    publish(identity: HostIdentity) {
      const temporary = join(root, `daemon-${instanceId}.json`);
      writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
      renameSync(temporary, join(root, 'daemon.json'));
    },
    release() {
      if (released) return;
      released = true;
      if (readHost(root)?.instanceId === instanceId) unlinkSync(join(root, 'daemon.json'));
      remove(lock, owner);
    },
  };
}
