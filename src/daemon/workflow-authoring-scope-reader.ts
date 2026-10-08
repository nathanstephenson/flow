import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

async function inspect(request: unknown): Promise<{ path: string; identity: string }> {
  const value = request as { operation?: unknown; path?: unknown; identity?: unknown } | null;
  if (!value || !['read', 'check'].includes(value.operation as string) || typeof value.path !== 'string' ||
    !value.path || value.path.length > 4096 || value.path.includes('\0') || !isAbsolute(value.path) ||
    (value.operation === 'check' && (resolve(value.path) !== value.path || typeof value.identity !== 'string' ||
      !/^\d{1,40}:\d{1,40}$/.test(value.identity)))) throw new Error();
  const path = await realpath(value.path);
  if (value.operation === 'check' && path !== value.path) throw new Error();
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || await realpath(path) !== path) throw new Error();
  const identity = `${stat.dev}:${stat.ino}`;
  if (value.operation === 'check' && identity !== value.identity) throw new Error();
  return { path, identity };
}

export function runWorkflowAuthoringScopeReader(): void {
  if (!process.send || process.env.FLOW_WORKFLOW_AUTHORING_SCOPE_READER !== '1') throw new Error();
  const timer = setTimeout(() => process.exit(1), 4500);
  process.once('disconnect', () => process.exit(1));
  process.once('message', (request: unknown) => {
    void inspect(request).then(result => ({ ok: true, result }), () => ({ ok: false })).then(response => {
      process.send!(response, () => { clearTimeout(timer); process.exit(0); });
    });
  });
}

if (!isSea() && process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { runWorkflowAuthoringScopeReader(); } catch { process.exitCode = 1; process.disconnect?.(); }
}
