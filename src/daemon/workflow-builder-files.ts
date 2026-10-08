import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, opendir, realpath, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { launchWorker } from '../backend/worker/launcher.ts';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandHome } from './projects.ts';

const MAX_READ = 128_000;
const MAX_ENTRIES = 200;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Darwin xnu bsd/sys/fcntl.h, introduced in macOS 11; Node does not expose it.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
// Never combine this with O_NOFOLLOW. Unsupported kernels must fail the probe.
const O_NOFOLLOW_ANY = 0x20000000;
const descriptorPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
let darwinGuard: Promise<void> | undefined;

/** Exercise the kernel, not just a constant/version check. Exported for fail-closed tests. */
export async function probeDarwinNoFollowAny(flags = O_NOFOLLOW_ANY): Promise<void> {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'flow-reader-probe-'));
  try {
    await mkdir(join(temporary, 'directory'));
    await writeFile(join(temporary, 'directory', 'file'), 'probe');
    await symlink('directory', join(temporary, 'ancestor'));
    await symlink('directory/file', join(temporary, 'leaf'));
    for (const [path, extra] of [['directory', constants.O_DIRECTORY], ['directory/file', 0]] as const) {
      const file = await open(join(temporary, path), constants.O_RDONLY | flags | extra);
      await file.close();
    }
    for (const [path, extra] of [['ancestor/file', 0], ['ancestor', constants.O_DIRECTORY], ['leaf', 0]] as const) {
      let refused = false;
      try {
        const file = await open(join(temporary, path), constants.O_RDONLY | flags | extra);
        await file.close();
      } catch (error) {
        // O_NOFOLLOW_ANY specifically reports ELOOP, not arbitrary I/O failure.
        refused = (error as NodeJS.ErrnoException).code === 'ELOOP';
      }
      if (!refused) throw new Error('Workflow builder Scope is unavailable');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
const within = (root: string, path: string) => path === root || path.startsWith(root === sep ? sep : root + sep);

/** Fail closed, including ancestor symlinks. Directory descriptors prevent symlink-swap races. */
async function directory(path: string): Promise<FileHandle> {
  if (process.platform === 'darwin') return open(path, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
  if (process.platform !== 'linux') throw new Error('Workflow builder Scope is unavailable');
  let current = await open(sep, directoryFlags);
  try {
    for (const part of path.split(sep).filter(Boolean)) {
      const next = await open(join(descriptorPath(current), part), directoryFlags);
      await current.close(); current = next;
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}

const credentialPart = (part: string) => part.startsWith('flow-workflow-builder-') || /^(?:\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.flow|\.pi|\.claude(?:\.json)?|\.codex|\.gemini|\.mcp\.json|mcp\.json|\.netrc|\.npmrc|\.pypirc|\.gitconfig|\.git|\.config|\.git-credentials|\.git-credential-cache|\.?\.?credentials?(?:\..*)?|\.?auth\.json|token|\.?secrets(?:\..*)?|keyrings|gcloud)$/i.test(part)
  || /\.(?:pem|key|p12|pfx)$/i.test(part) || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?$/.test(part);

export class WorkflowBuilderFiles {
  readonly scope: string;
  private readonly root: FileHandle;
  private readonly identity: { dev: bigint; ino: bigint };
  private readonly protectedPaths: string[];
  private closed = false;
  private active = 0;
  private readonly drained: Array<() => void> = [];
  private readonly helpers = new Set<ReturnType<typeof launchWorker>>();
  private closing: Promise<void> | undefined;
  private constructor(scope: string, root: FileHandle, identity: { dev: bigint; ino: bigint }, protectedPaths: string[]) {
    this.scope = scope; this.root = root; this.identity = identity; this.protectedPaths = protectedPaths;
  }

  static async create(path: string, stateRoot: string): Promise<WorkflowBuilderFiles> {
    if (!isAbsolute(expandHome(path))) throw new Error('Workflow builder Scope is unavailable');
    const scope = resolve(expandHome(path));
    if (process.platform === 'darwin') await (darwinGuard ??= probeDarwinNoFollowAny());
    const root = await directory(scope);
    try {
      if (await realpath(scope) !== scope) throw new Error();
      const roots = ['/proc', '/dev', '/sys', '/run', stateRoot, join(homedir(), '.flow'), process.env.FLOW_STATE_DIR, process.env.PI_CODING_AGENT_DIR, process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, process.env.CLAUDE_AGENT_SDK_AUTH_CONFIG_DIR];
      const protectedPaths = await Promise.all(roots.filter((item): item is string => !!item).map(async item => {
        const path = resolve(expandHome(item));
        return await realpath(path).catch(() => path);
      }));
      if (protectedPaths.some(path => within(path, scope))) throw new Error();
      return new WorkflowBuilderFiles(scope, root, await root.stat({ bigint: true }), protectedPaths);
    } catch { await root.close(); throw new Error('Workflow builder Scope is unavailable'); }
  }

  protect(path: string): void { this.protectedPaths.push(resolve(path)); }

  /** Virtual metadata must obey the same pinned-directory boundary as reference reads. */
  async checkScope(): Promise<void> {
    return this.operation(async () => {
      const check = await directory(this.scope);
      try {
        const stat = await check.stat({ bigint: true });
        if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw new Error('Workflow builder Scope changed. Close and reopen the builder.');
      } finally { await check.close(); }
    });
  }

  private allowed(path: string): boolean {
    return !path.split(sep).some(credentialPart) && !this.protectedPaths.some(root => within(root, path));
  }

  private async target(path: string, listing: boolean): Promise<FileHandle> {
    if (this.closed || typeof path !== 'string' || path.length > 4096 || path.includes('\0')) throw new Error();
    const absolute = resolve(this.scope, path);
    if (!within(this.scope, absolute) || !this.allowed(absolute)) throw new Error();
    // Reopen from / with no-follow on every ancestor: a renamed or redirected root is refused.
    const check = await directory(this.scope);
    try {
      const stat = await check.stat({ bigint: true });
      if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw new Error();
    } finally { await check.close(); }
    const parts = relative(this.scope, absolute).split(sep).filter(Boolean);
    if (parts.length > 64) throw new Error();
    let current = await open(descriptorPath(this.root), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const [index, part] of parts.entries()) {
        const final = index === parts.length - 1;
        const next = await open(join(descriptorPath(current), part), final && !listing
          ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : directoryFlags);
        await current.close(); current = next;
      }
      const actual = await realpath(descriptorPath(current));
      if (!within(this.scope, actual) || !this.allowed(actual)) throw new Error();
      const stat = await current.stat();
      if (listing ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_READ) throw new Error();
      return current;
    } catch (error) { await current.close(); throw error; }
  }

  async read(path: string): Promise<string> {
    return this.operation(async () => {
      if (process.platform === 'darwin') return this.darwinReference(path, false);
      const file = await this.target(path, false);
      try {
        const bytes = Buffer.alloc(MAX_READ + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await file.read(bytes, size, bytes.length - size, size);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > MAX_READ) throw new Error();
        return bytes.subarray(0, size).toString('utf8');
      } finally { await file.close(); }
    });
  }

  async list(path: string): Promise<string> {
    return this.operation(async () => {
      if (process.platform === 'darwin') return this.darwinReference(path, true);
      const file = await this.target(path, true);
      try {
        const entries: string[] = [];
        let visits = 0;
        const dir = await opendir(descriptorPath(file), { bufferSize: 32 });
        for await (const entry of dir) {
          if (++visits > MAX_ENTRIES) { entries.push('[listing truncated]'); break; }
          if (!(entry.isDirectory() || entry.isFile()) || !this.allowed(resolve(this.scope, path, entry.name))) continue;
          entries.push(entry.name + (entry.isDirectory() ? '/' : ''));
        }
        return entries.sort().join('\n');
      } finally { await file.close(); }
    });
  }

  private async darwinReference(path: string, listing: boolean): Promise<string> {
    if (this.closed || typeof path !== 'string' || path.length > 4096 || path.includes('\0')) throw new Error();
    const absolute = resolve(this.scope, path);
    if (!within(this.scope, absolute) || !this.allowed(absolute)) throw new Error();
    const normalized = relative(this.scope, absolute) || '.';
    if (normalized.split(sep).length > 64) throw new Error();
    // All per-reference filesystem work, including rechecking the Scope path,
    // belongs to the disposable helper so slow metadata I/O is killable too.
    const source = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(new URL(source ? './workflow-builder-reader.ts' : './workflow-builder-reader.js', import.meta.url));
    // No inherited Node preload/loader flags, dynamic-library injection or plugin
    // environment. The executable, entry, argv and cwd are all host-selected.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    env.FLOW_WORKFLOW_BUILDER_READER = '1';
    const helper = launchWorker({
      ...(isSea() ? { args: ['--flow-workflow-builder-reader'] } : { entry, execArgv: source ? ['--experimental-strip-types'] : [] }),
      cwd: this.scope, env, stdioFds: [this.root.fd], shutdownTimeoutMs: 0,
    });
    this.helpers.add(helper);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error()), 5000);
        helper.child.once('error', reject);
        helper.child.once('disconnect', () => reject(new Error()));
        void helper.exited.then(() => reject(new Error()));
        helper.child.once('message', (message: unknown) => {
          const response = message as { ok?: boolean; result?: unknown } | null;
          if (!response || response.ok !== true) reject(new Error());
          else resolve(response.result);
        });
        helper.child.send({ scope: this.scope, operation: listing ? 'list' : 'read', path: normalized }, error => { if (error) reject(error); });
      });
      await helper.stop(async () => {});
      if (this.closed || !this.allowed(absolute)) throw new Error();
      if (!listing) {
        const content = (result as { content?: unknown } | null)?.content;
        if (typeof content !== 'string' || content.length > MAX_READ) throw new Error();
        return content;
      }
      const response = result as { entries?: Array<{ name: string; directory: boolean }>; truncated?: boolean } | null;
      if (!response || !Array.isArray(response.entries) || response.entries.length > MAX_ENTRIES || typeof response.truncated !== 'boolean') throw new Error();
      const entries: string[] = [];
      for (const entry of response.entries) {
        if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.length > 1024 ||
          entry.name.includes('/') || entry.name.includes('\0') || ['.', '..'].includes(entry.name) || typeof entry.directory !== 'boolean') throw new Error();
        if (this.allowed(resolve(absolute, entry.name))) entries.push(entry.name + (entry.directory ? '/' : ''));
      }
      if (response.truncated) entries.push('[listing truncated]');
      return entries.sort().join('\n');
    } finally {
      clearTimeout(timer);
      await helper.stop(async () => {});
      this.helpers.delete(helper);
    }
  }

  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.active >= 8) throw new Error('Workflow reference unavailable');
    this.active++;
    try { return await work(); } catch { throw new Error('Workflow reference unavailable'); } finally {
      if (--this.active === 0) for (const resolve of this.drained.splice(0)) resolve();
    }
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      await Promise.all([...this.helpers].map(helper => helper.stop(async () => {})));
      if (this.active) await new Promise<void>(resolve => this.drained.push(resolve));
      // fd4 inheritance stays valid until every active operation has terminated.
      await this.root.close().catch(() => {});
    })();
  }
}
