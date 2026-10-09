import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToolchainAssets } from "./toolchain-assets.ts";
const virtualRoot = "/tmp/flow-isolation";
const virtualState = `${virtualRoot}/state`;
const virtualHome = `${virtualRoot}/home`;

export type FilesystemIsolationOptions = {
  scope: string;
  /** Canonical binding recorded when Scope was selected; refuse later symlink redirection. */
  expectedScope?: string;
  expectedScopeIdentity?: string;
  /** A dedicated directory named `backend`, not the Session Host state root. Kept for Revive. */
  stateDir?: string;
  /** The owning Session Host root, including a non-default FLOW_STATE_DIR. */
  stateRoot?: string;
  protectedPaths?: string[];
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** The caller must supply fd 3 (Node IPC), with serialization: "advanced", when spawning. */
  ipc?: boolean;
  /** Execution assets hidden by masks, mounted read-only at real paths; narrow lookup aliases are preserved. */
  readablePaths?: string[];
  credentials?: "pi" | "claude" | "none";
  workflowBuilder?: boolean;
};

export type FilesystemIsolation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Host-owned mount descriptors, consumed and closed by Bubblewrap before program exec. */
  stdioFds: number[];
  /** Canonical Scope; use this for adapter options and any subsequent cwd selection. */
  scope: string;
  /** Path inside the worker; pass this, not the host path, to the Backend Adapter. */
  stateDir: string;
  /** Call only after the process and its descendants have exited. Idempotent. */
  cleanup(): void;
};

function within(path: string, parent: string): boolean {
  const tail = relative(parent, path);
  return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

/** Resolve existing ancestors too: an absent secret path may have a symlinked parent. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonical(parent), basename(absolute));
  }
}

/** Mask an existing ancestor instead of dropping protection for a future credential path. */
function existingMask(path: string): string {
  while (!existsSync(path)) {
    const parent = dirname(path);
    if (parent === path) throw new Error(`Cannot mask protected path: ${path}`);
    path = parent;
  }
  if (path === "/") throw new Error("Protected path has no safe existing ancestor");
  return path;
}

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

async function probeBoundary(command: string, args: string[], env: NodeJS.ProcessEnv, fds: (number | "ignore")[]): Promise<void> {
  await new Promise<void>((resolveProbe, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe", ...fds] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveProbe();
      else reject(Object.assign(new Error("Boundary probe failed"), { code, signal, stderr }));
    });
  });
}

async function executable(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = command.includes("/") ? [resolve(command)]
    : (env.PATH ?? "/usr/bin:/bin").split(":").map((dir) => resolve(dir, command));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch { /* Try the next PATH entry. No unrestricted fallback. */ }
  }
  throw new Error(`Executable not found: ${command}`);
}

function scrubEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // Undefined entries also override launchers which merge process.env into this result.
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
    if (/^(FLOW_|LD_|DYLD_|XDG_|PI_SESSION_)/.test(key) || /^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ZDOTDIR|TMPDIR|TMP|TEMP|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|SSH_AUTH_SOCK|SSH_AGENT_PID|DBUS_SESSION_BUS_ADDRESS|DOCKER_HOST|CONTAINER_HOST|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE)$/.test(key)) {
      env[key] = undefined;
    }
  }
  Object.assign(env, {
    HOME: virtualHome, TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp",
    XDG_CONFIG_HOME: `${virtualHome}/.config`, XDG_CACHE_HOME: `${virtualHome}/.cache`,
    XDG_DATA_HOME: `${virtualHome}/.local/share`, XDG_STATE_HOME: `${virtualHome}/.local/state`,
    XDG_RUNTIME_DIR: `${virtualRoot}/run`,
    PI_CODING_AGENT_DIR: `${virtualHome}/.pi/agent`,
    PI_CODING_AGENT_SESSION_DIR: `${virtualState}/sessions`,
    CLAUDE_CONFIG_DIR: `${virtualHome}/.claude`,
  });
  return env;
}

function scopeContext(options: Pick<FilesystemIsolationOptions, "scope" | "expectedScope" | "env" | "protectedPaths" | "stateRoot">) {
  const inherited = { ...process.env, ...options.env };
  const home = canonical(homedir());
  const credentialHome = canonical(inherited.HOME ?? home);
  const piDir = canonical(expandHome(inherited.PI_CODING_AGENT_DIR ?? join(credentialHome, ".pi/agent"), credentialHome));
  // Relative Claude roots resolve against the CLI's Scope, not this host's cwd;
  // literal ~ is not expanded by Claude either. Refuse rather than mask/stage the
  // wrong store. Empty roots retain the SDK's default-home semantics.
  for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const) {
    if (inherited[key] && !isAbsolute(inherited[key])) throw new Error(`${key} must be absolute when filesystem isolation is enabled`);
  }
  const claudeDir = canonical(inherited.CLAUDE_CONFIG_DIR || join(credentialHome, ".claude"));
  // Claude can use a separate auth/lock root. An explicit empty override means the
  // default home store, not the config root. Mask the real source and stage only its
  // credential file; never propagate this host-root override into a restricted worker.
  const authRoot = inherited.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const claudeAuthDir = canonical(authRoot === undefined ? claudeDir : authRoot || join(credentialHome, ".claude"));
  const flowRoots = [...new Set([join(home, ".flow"), inherited.FLOW_STATE_DIR, process.env.FLOW_STATE_DIR, options.stateRoot]
    .filter((path): path is string => !!path).map(canonical))];
  const runtimePaths = [process.env, inherited].flatMap((env) => {
    const sockets = [env.SSH_AUTH_SOCK,
      ...[env.DOCKER_HOST, env.CONTAINER_HOST].map((value) => value?.startsWith('unix://') ? value.slice(7) : undefined),
      env.DBUS_SESSION_BUS_ADDRESS?.match(/(?:^|;)unix:path=([^,;]+)/)?.[1]];
    const runtime = env.XDG_RUNTIME_DIR;
    return [...sockets, ...(runtime && !['/tmp', '/var/tmp', '/run'].some((root) => within(canonical(runtime), canonical(root))) ? [runtime] : [])]
      .filter((path): path is string => !!path && isAbsolute(path));
  });
  const hostCredentials = [home, credentialHome].flatMap((root) =>
    [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".local/share/keyrings",
      ".netrc", ".npmrc", ".git-credentials", ".git-credential-cache", ".cache/git/credential"]
      .map((name) => join(root, name)));
  const protectedPaths = [...new Set([...flowRoots, ...hostCredentials, ...runtimePaths, join(home, ".pi/agent"), join(home, ".claude"), join(home, ".claude.json"),
    piDir, claudeDir, claudeAuthDir, join(credentialHome, ".claude.json"), ...(options.protectedPaths ?? [])].map(canonical))];
  const scope = realpathSync(options.scope);
  if (options.expectedScope !== undefined && scope !== resolve(options.expectedScope)) {
    throw new Error('Scope changed since selection; refusing redirected execution');
  }
  if (!statSync(scope).isDirectory()) throw new Error("Scope must be a directory");
  const launcher = inherited.FLOW_BWRAP_PATH ?? "/usr/bin/bwrap";
  if ((isAbsolute(launcher) && within(canonical(launcher), scope)) || within(canonical(process.execPath), scope)) {
    throw new Error("Unsafe Scope: would expose a trusted launch executable");
  }
  const temporary = relative(canonical("/tmp"), scope).split(sep)[0];
  if (/^flow-isolation-[A-Za-z0-9]{6}$/.test(temporary ?? "")) throw new Error("Unsafe Scope: private isolation staging path");
  if (within(home, scope) || within(credentialHome, scope) || within(canonical("/tmp"), scope)
    || within(canonical(virtualRoot), scope) || within(scope, canonical(virtualRoot))
    || ["/proc", "/sys", "/dev", "/run", "/var/run", "/var/tmp"].some((path) => within(scope, canonical(path)))) {
    throw new Error("Unsafe Scope: root, home, or reserved isolation path");
  }
  for (const path of protectedPaths) {
    if (within(path, scope)) throw new Error(`Scope would expose protected host state: ${path}`);
    if (within(scope, path)) {
      const worktree = join(path, "worktrees");
      if (!flowRoots.includes(path) || !within(scope, worktree) || relative(worktree, scope).split(sep).length < 2) {
        throw new Error(`Scope is inside protected host state: ${path}`);
      }
    }
  }
  return { inherited, home, credentialHome, piDir, claudeDir, claudeAuthDir, flowRoots, protectedPaths, scope };
}

/** Validate Scope against the shared policy before preparing or probing a restricted launch. */
export function validateFilesystemScope(options: Pick<FilesystemIsolationOptions, "scope" | "expectedScope" | "env" | "protectedPaths" | "stateRoot">): string {
  return scopeContext(options).scope;
}

/**
 * Linux-only, fail-closed filesystem boundary shared by workers, MCP stdio and Workflow code.
 * The host filesystem is read-only, except the canonical Scope and one private backend directory.
 * Host state/auth, common socket locations and the host process table are hidden. Network is
 * intentionally shared for model access: external services (including loopback HTTP), credentials
 * deliberately passed to the worker, and sockets elsewhere are NOT confined by this boundary.
 * The caller owns process supervision; cleanup must follow termination, never precede it.
 */
export async function prepareFilesystemIsolation(options: FilesystemIsolationOptions): Promise<FilesystemIsolation> {
  if (process.platform !== "linux") throw new Error("Filesystem isolation unavailable; unrestricted launch refused: requires Linux and Bubblewrap");
  let scratch: string | undefined;
  const sources: number[] = [];
  const cleanup = () => {
    try { if (scratch) { rmSync(scratch, { recursive: true, force: true }); scratch = undefined; } }
    finally { for (const fd of sources.splice(0)) closeSync(fd); }
  };
  // Pin validated mount sources in the host only, not inherited application descriptors. A
  // concurrently writable ancestor must not swap Scope for a symlink between validation and bind.
  const pinned = (path: string, expectedIdentity?: string) => {
    const before = statSync(path, { bigint: true });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0));
    sources.push(fd);
    const after = fstatSync(fd, { bigint: true });
    if (expectedIdentity !== undefined && `${after.dev}:${after.ino}` !== expectedIdentity) {
      throw new Error("Scope changed since selection; refusing replaced directory");
    }
    if (before.dev !== after.dev || before.ino !== after.ino || realpathSync(`/proc/self/fd/${fd}`) !== path) {
      throw new Error(`Execution mount source changed during preparation: ${path}`);
    }
    return String((options.ipc ? 4 : 3) + sources.length - 1);
  };
  try {
    const { inherited, home, credentialHome, piDir, claudeDir, claudeAuthDir, flowRoots, protectedPaths, scope } = scopeContext(options);
    const env = scrubEnvironment(inherited);
    if (options.credentials === "claude" && inherited.FLOW_CLAUDE_PATH) env.FLOW_CLAUDE_PATH = inherited.FLOW_CLAUDE_PATH;
    // npm extends PATH with project-controlled .bin directories. They must never select our
    // enforcement program; an explicit operator override must also be outside writable Scope.
    const launcher = inherited.FLOW_BWRAP_PATH ?? "/usr/bin/bwrap";
    if (!isAbsolute(launcher)) throw new Error("FLOW_BWRAP_PATH must be an absolute trusted executable path");
    const bwrap = await executable(launcher, env);
    if (within(bwrap, scope)) throw new Error("Unsafe Scope: would expose the trusted isolation launcher");
    if (flowRoots.some((root) => /^sessions\/[^/]+\/backend(?:\/|$)/.test(relative(root, bwrap))
        || within(bwrap, join(root, 'worktrees')))
      || /^flow-isolation-[A-Za-z0-9]{6}(?:\/|$)/.test(relative(canonical('/tmp'), bwrap))) {
      throw new Error("Trusted launch executable must be outside writable backend state and scratch");
    }
    const command = await executable(options.command, env);
    const maskRoots = [...protectedPaths.map(existingMask), canonical('/tmp'), canonical('/var/tmp'), canonical('/run')];
    const tools = pathToolchainAssets(env.PATH ?? '/usr/bin:/bin', scope,
      path => maskRoots.some(root => within(path, root)),
      path => protectedPaths.some(root => within(path, root)) || ['/var/tmp', '/run'].some(root => within(path, canonical(root))));
    env.PATH = tools.path;
    const aliases = new Map<string, string>();
    const readable = [...new Set([command, ...tools.assets, ...(options.readablePaths ?? []),
      ...(env.FLOW_CLAUDE_PATH ? [await executable(env.FLOW_CLAUDE_PATH, env)] : [])].map(asset => {
        const source = realpathSync(asset);
        // Preserve every lookup symlink, including $PREFIX/lib -> another library directory.
        // Canonicalize each alias's parents to prevent an ancestor alias grafting into hidden
        // state. Do not mount alias targets' parents: only the requested canonical leaf is data.
        let logical: string = sep;
        for (const name of resolve(asset).split(sep).filter(Boolean)) {
          logical = join(logical, name);
          if (lstatSync(logical).isSymbolicLink()) {
            const destination = join(canonical(dirname(logical)), basename(logical));
            aliases.set(destination, realpathSync(logical));
          }
        }
        return source;
      }))];
    const validateAsset = (path: string) => {
      if ([home, credentialHome, "/", ...["/tmp", "/var/tmp", "/run", "/var/run", "/proc", "/dev", "/sys"].map(canonical)].includes(path)
        || protectedPaths.some((secret) => within(path, secret) || within(secret, path))
        || within(path, virtualRoot) || ["/proc", "/dev", "/sys", "/run", "/var/tmp"].some((root) => within(path, canonical(root)))) {
        throw new Error(`Readable execution asset would expose protected state: ${path}`);
      }
    };
    readable.forEach(validateAsset);
    // Never stage credentials under operator TMPDIR: it could be inside a writable Scope.
    scratch = mkdtempSync(join(canonical("/tmp"), "flow-isolation-"));
    const backend = options.stateDir ? realpathSync(options.stateDir) : join(scratch, "backend");
    if (options.stateDir) {
      if (basename(backend) !== "backend" || !statSync(backend).isDirectory() || within(home, backend) || within(credentialHome, backend)
        || within(scope, backend) || within(backend, scope) || within(backend, virtualRoot) || within(virtualRoot, backend)) {
        throw new Error("stateDir must be a dedicated backend directory, separate from Scope");
      }
      for (const path of protectedPaths) {
        if (within(path, backend)) throw new Error("stateDir would widen access to protected host state");
        if (within(backend, path) && (!flowRoots.includes(path) || !/^sessions\/[^/]+\/backend$/.test(relative(path, backend)))) {
          throw new Error("Inside host state, stateDir must be sessions/<id>/backend, never sessions or secrets");
        }
      }
    } else mkdirSync(backend, { mode: 0o700 });
    // These programs run outside the boundary, including during the probe. Neither Scope nor
    // private state may grant a model authority to replace them before a later launch/Revive.
    for (const trusted of [bwrap, canonical(process.execPath)]) {
      if ([backend, scratch].some((writable) => within(trusted, writable))) {
        throw new Error("Trusted launch executable must be outside writable backend state and scratch");
      }
    }

    const args = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
      "--ro-bind", "/", "/", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", canonical("/run")];
    // Masks must precede the selected Worktree bind. Remount only the parent, not its children.
    const masks = [...new Set([...protectedPaths, backend, scratch]
      .filter((path) => !["/tmp", "/var/tmp", "/run"].some((root) => within(path, canonical(root))))
      .map(existingMask))]
      .sort((a, b) => a.length - b.length)
      .filter((path, index, paths) => !paths.slice(0, index).some((parent) => within(path, parent)));
    const directoryMasks: string[] = [];
    for (const path of masks) {
      if (statSync(path).isDirectory()) { args.push("--tmpfs", path); directoryMasks.push(path); }
      else args.push("--ro-bind", "/dev/null", path);
    }
    // Ancestor masks may hide runtime assets too. Restore only explicitly validated assets,
    // never the ancestor itself: new host credentials must stay hidden for this worker's life.
    for (const path of readable) {
      if ((within(path, canonical("/tmp")) || masks.some((mask) => within(path, mask)))
        && !within(path, scope)) args.push("--ro-bind-fd", pinned(path), path);
    }
    for (const [destination, source] of aliases) {
      if (!within(destination, scope)
        && (within(destination, canonical('/tmp')) || masks.some(mask => within(destination, mask)))
        && !readable.some(parent => within(destination, parent) && statSync(parent).isDirectory())) {
        validateAsset(destination); validateAsset(source);
        // Keep a symlink, not a second directory bind: Node realpath must still resolve to
        // the pinned canonical tree so the linked package's own ancestor dependencies work.
        // Parents are empty mask directories; a restored asset parent already carries its alias.
        args.push('--symlink', source, destination);
      }
    }
    const privateHome = join(scratch, "home");
    mkdirSync(join(privateHome, ".pi/agent"), { recursive: true, mode: 0o700 });
    mkdirSync(join(privateHome, ".claude"), { mode: 0o700 });
    args.push("--bind-fd", pinned(scope, options.expectedScopeIdentity), scope, "--dir", virtualRoot, "--bind-fd", pinned(privateHome), virtualHome,
      "--dir", `${virtualRoot}/run`, "--bind-fd", pinned(backend), virtualState);
    for (const path of directoryMasks) args.push("--remount-ro", path);

    const stage = (source: string, destination: string) => {
      if (!existsSync(source)) return;
      if (!statSync(source).isFile() || realpathSync(source) !== resolve(source)) {
        throw new Error(`Credential must be a regular, non-symlink file: ${source}`);
      }
      // Mutable SDK-local copies permit OAuth refresh, file locks and atomic config rewrites.
      // Only this private staging tree is writable: never write refreshed data back to the source.
      writeFileSync(join(privateHome, relative(virtualHome, destination)), readFileSync(source), { mode: 0o600 });
    };
    const resources = (label: string, directory: string, destination: string, names: string[]) => {
      for (const name of names) {
        const source = join(directory, name);
        if (!existsSync(source)) continue;
        const asset = realpathSync(source);
        if (asset !== source || protectedPaths.some((secret) => secret !== directory &&
          (within(asset, secret) || within(secret, asset)))) throw new Error(`Unsafe ${label} resource: ${source}`);
        args.push("--ro-bind-fd", pinned(asset), join(destination, name));
      }
    };
    if (options.credentials === "pi") {
      for (const name of ["auth.json", "models.json", "settings.json"]) stage(join(piDir, name), join(env.PI_CODING_AGENT_DIR!, name));
      if (!options.workflowBuilder) resources("Pi", piDir, env.PI_CODING_AGENT_DIR!, ["AGENTS.md", "skills", "prompts", "themes", "extensions", "packages", "bin", "tools"]);
    } else if (options.credentials === "claude") {
      stage(join(claudeAuthDir, ".credentials.json"), join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"));
      const config = existsSync(join(claudeDir, ".claude.json")) ? join(claudeDir, ".claude.json") : join(credentialHome, ".claude.json");
      stage(config, join(virtualHome, ".claude.json"));
      stage(config, join(env.CLAUDE_CONFIG_DIR!, ".claude.json"));
      if (!options.workflowBuilder) resources("Claude", claudeDir, env.CLAUDE_CONFIG_DIR!, ["CLAUDE.md", "commands", "skills", "agents", "rules", "plugins"]);
      // The CLI owns its project transcripts. Persist only that subtree, not global credentials.
      const projects = join(backend, "claude-projects");
      if (!existsSync(projects)) mkdirSync(projects, { mode: 0o700 });
      if (!statSync(projects).isDirectory() || realpathSync(projects) !== projects) {
        throw new Error("Unsafe Claude backend transcript directory");
      }
      args.push("--bind-fd", pinned(projects), join(env.CLAUDE_CONFIG_DIR!, "projects"));
    }
    // Mount descriptors are consumed before hiding the host process table.
    args.push("--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev");
    // Clear inside Bubblewrap as well: callers may merge env with their own inherited environment.
    args.push("--clearenv");
    for (const [key, value] of Object.entries(env)) if (value !== undefined) args.push("--setenv", key, value);
    args.push("--chdir", scope);
    // Probe the actual mount policy and namespaces, not merely `bwrap --version`. Never run the
    // requested program when unavailable; no cached probe can turn a later failure into fallback.
    try {
      // Reserve fd 3 in the probe exactly as in an IPC worker launch.
      await probeBoundary(bwrap, [...args, "--", "/bin/true"], env,
        [...(options.ipc ? ["ignore" as const] : []), ...sources]);
    } catch (error) {
      // execFile's default message includes every --setenv argument, including provider keys.
      const failure = error as NodeJS.ErrnoException & { stderr?: string; signal?: string };
      throw new Error(`Bubblewrap namespace/mount probe failed (${failure.signal ?? failure.code ?? "unknown"}): ${(failure.stderr ?? "").trim().slice(-2048)}`);
    }
    // Bubblewrap (unlike some other sandbox launchers) retains inherited application fds;
    // it has no --preserve-fds option. Restore Node's spawn-time IPC environment after clearenv.
    if (options.ipc) args.push("--setenv", "NODE_CHANNEL_FD", "3", "--setenv", "NODE_CHANNEL_SERIALIZATION_MODE", "advanced",
      "--setenv", "FLOW_BACKEND_WORKER", "1");
    args.push("--", command, ...options.args);
    return { command: bwrap, args, env, stdioFds: sources.slice(), scope, stateDir: virtualState, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(`Filesystem isolation unavailable; unrestricted launch refused: ${(error as Error).message}`, { cause: error });
  }
}
