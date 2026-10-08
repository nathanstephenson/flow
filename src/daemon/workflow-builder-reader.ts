// Disposable, trusted reader entry. Keep all runtime imports builtins-only: no host,
// Backend Adapter, plugin, user configuration, or model-provided code is loaded here.
import { constants, fstatSync } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
// Darwin (macOS 11+). This is NOT O_NOFOLLOW and the two
// flags must not be combined. The parent feature-probes actual kernel behavior.
const O_NOFOLLOW_ANY = 0x20000000;
const MAX_READ = 128_000;
const MAX_ENTRIES = 200;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;
const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;

type Request = { scope: string; operation: 'read' | 'list' | 'check'; path: string };

async function checkScope(scope: string, root: { dev: bigint; ino: bigint }): Promise<void> {
  // Opening the canonical absolute Scope with ANY also refuses a new ancestor or
  // leaf alias to the very same inode (the cwd identity check alone would not).
  const check = await open(scope, directoryFlags);
  try { if (!same(await check.stat({ bigint: true }), root)) throw new Error(); }
  finally { await check.close(); }
}

async function reference(request: Request): Promise<unknown> {
  // Only normalized relative paths, never a descriptor path or an absolute path.
  if (!request || !['read', 'list', 'check'].includes(request.operation) || typeof request.path !== 'string' ||
    request.path.length > 4096 || request.path.includes('\0') || isAbsolute(request.path) ||
    normalize(request.path) !== request.path || request.path.split('/').some(part => part === '..') ||
    request.path.split('/').length > 64 || (request.operation === 'check' && request.path !== '.') ||
    typeof request.scope !== 'string' || request.scope.length > 4096 ||
    request.scope.includes('\0') || !isAbsolute(request.scope) || resolve(request.scope) !== request.scope) throw new Error();
  const root = fstatSync(4, { bigint: true });
  if (!root.isDirectory()) throw new Error();
  await checkScope(request.scope, root);
  const cwd = await open('.', directoryFlags);
  try { if (!same(await cwd.stat({ bigint: true }), root)) throw new Error(); }
  finally { await cwd.close(); }
  if (request.operation === 'check') return { checked: true };

  let target: FileHandle | undefined;
  try {
    target = await open(request.path, request.operation === 'list' ? directoryFlags
      : constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
    const stat = await target.stat({ bigint: true });
    // Refuse cross-device mounts, in addition to symlinks and non-regular files.
    if (stat.dev !== root.dev || (request.operation === 'list' ? !stat.isDirectory()
      : !stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_READ))) throw new Error();
    if (request.operation === 'read') {
      const bytes = Buffer.alloc(MAX_READ + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await target.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_READ) throw new Error();
      return { content: bytes.subarray(0, size).toString('utf8') };
    }
    // /dev/fd/N/child is ENOTDIR on Darwin. Changing cwd is safe ONLY in this
    // one-shot process. Recheck the directory identity after the path-based chdir.
    process.chdir(request.path);
    const actual = await open('.', directoryFlags);
    try { if (!same(await actual.stat({ bigint: true }), stat)) throw new Error(); }
    finally { await actual.close(); }
    const entries: Array<{ name: string; directory: boolean }> = [];
    let visits = 0;
    let truncated = false;
    const dir = await opendir('.', { bufferSize: 32 });
    for await (const entry of dir) {
      if (++visits > MAX_ENTRIES) { truncated = true; break; }
      if (!(entry.isDirectory() || entry.isFile())) continue;
      // Exclude mounted directory entries too. Never enumerate through a link.
      const childStat = await lstat(entry.name, { bigint: true }).catch(() => undefined);
      if (!childStat || childStat.dev !== root.dev || (entry.isDirectory() ? !childStat.isDirectory()
        : !childStat.isFile() || childStat.nlink !== 1n)) continue;
      entries.push({ name: entry.name, directory: entry.isDirectory() });
    }
    return { entries, truncated };
  } finally {
    await target?.close();
    await checkScope(request.scope, root);
  }
}

export function runWorkflowBuilderReader(): void {
  if (process.platform !== 'darwin' || !process.send || process.env.FLOW_WORKFLOW_BUILDER_READER !== '1') {
    throw new Error('Workflow reference unavailable');
  }
  // Also bound orphaned helpers. The parent independently kills and reaps at 5s.
  const timer = setTimeout(() => process.exit(1), 4500);
  process.once('disconnect', () => process.exit(1));
  process.once('message', (request: Request) => {
    void reference(request).then(result => ({ ok: true, result }), () => ({ ok: false })).then(response => {
      process.send!(response, () => { clearTimeout(timer); process.exit(0); });
    });
  });
}

// Direct Node source/compiled entry. SEA dispatch happens in cli/main.ts instead.
if (!isSea() && process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { runWorkflowBuilderReader(); } catch { process.exitCode = 1; process.disconnect?.(); }
}
