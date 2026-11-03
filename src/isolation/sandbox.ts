import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { sandboxSupervisorSource } from "./sandbox-supervisor.ts";

export type SandboxProvider = {
  version: 1; nodePath: string; claudePath: string; claudeAuthDir?: string;
  probe: string[]; create: string[]; exec: string[]; remove: string[];
};
export type SandboxSupport =
  | { supported: true; path: string; provider: SandboxProvider }
  | { supported: false; reason: string };
export type SandboxSupportDetector = (options: { stateRoot: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<SandboxSupport>;

const placeholders = {
  probe: { allowed: [], required: [] },
  create: { allowed: ["{spec}", "{name}"], required: ["{spec}"] },
  exec: { allowed: ["{name}", "{cwd}"], required: ["{name}", "{cwd}"] },
  remove: { allowed: ["{name}"], required: ["{name}"] },
} as const;

export function sandboxUnavailable(): Error {
  return new Error("Sandbox isolation is unavailable; unrestricted launch refused");
}

export function sandboxProviderPath(stateRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.FLOW_SANDBOX_PROVIDER || join(stateRoot, "sandbox-provider.json");
}

export function parseSandboxProvider(text: string): SandboxProvider {
  const value = JSON.parse(text) as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || value.version !== 1) throw new Error("version must be 1");
  for (const key of ["nodePath", "claudePath", "claudeAuthDir"] as const) {
    if (key === "claudeAuthDir" && value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !isAbsolute(value[key])) throw new Error(`${key} must be an absolute path`);
  }
  for (const [command, { allowed, required }] of Object.entries(placeholders)) {
    const template = value[command];
    if (!Array.isArray(template) || !template.length || !template.every((part) => typeof part === "string" && part.length)) {
      throw new Error(`${command} must be a non-empty array of strings`);
    }
    for (const part of template as string[]) {
      if (/^\{.*\}$/.test(part) && !(allowed as readonly string[]).includes(part)) throw new Error(`${command} has unknown placeholder ${part}`);
    }
    for (const part of required) if (!template.includes(part)) throw new Error(`${command} must contain ${part}`);
  }
  return value as SandboxProvider;
}

export function fillTemplate(template: string[], values: Record<string, string>): string[] {
  return template.map((part) => {
    const key = /^\{(.+)\}$/.exec(part)?.[1];
    return key !== undefined && key in values ? values[key]! : part;
  });
}

export const detectSandboxSupport: SandboxSupportDetector = async ({ stateRoot, env = process.env, timeoutMs = 300_000 }) => {
  const path = sandboxProviderPath(stateRoot, env);
  let provider: SandboxProvider;
  try { provider = parseSandboxProvider(readFileSync(path, "utf8")); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { supported: false, reason: missing ? `No sandbox provider file at ${path}.` : `Invalid sandbox provider file ${path}: ${(error as Error).message}` };
  }
  const [command, ...args] = provider.probe;
  return new Promise((resolve) => {
    execFile(command!, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) resolve({ supported: false, reason: `Sandbox provider probe failed: ${stderr.trim().slice(-1024) || error.message}` });
      else resolve({ supported: true, path, provider });
    });
  });
};

export type SandboxMount = { path: string; readOnly: boolean; dev: number; ino: number };
export type SandboxSpec = { name: string; workspace: string; mounts: SandboxMount[]; env: Record<string, string> };
export type Sandbox = {
  name: string;
  nodePath: string;
  command(cwd: string, argv: string[], env: Record<string, string>): { command: string; args: string[] };
  /** Keeps the VM while other owned work runs; the VM is removed when the owner closes and no hold remains. */
  hold(): () => void;
  close(): Promise<void>;
};

export function sandboxMounts(writable: string[], readable: string[]): SandboxMount[] {
  const mounts = new Map<string, boolean>();
  for (const path of writable) mounts.set(realpathSync(path), false);
  for (const path of readable) {
    const real = realpathSync(path);
    if (!mounts.has(real)) mounts.set(real, true);
  }
  const sorted = [...mounts].sort(([a], [b]) => a.length - b.length);
  const kept: [string, boolean][] = [];
  for (const [path, readOnly] of sorted) {
    if (kept.some(([parent, parentReadOnly]) => parentReadOnly === readOnly && (path === parent || path.startsWith(parent + sep)))) continue;
    kept.push([path, readOnly]);
  }
  return kept.map(([path, readOnly]) => {
    const stat = statSync(path);
    return { path, readOnly, dev: stat.dev, ino: stat.ino };
  });
}

function runProvider(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(command!, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Sandbox provider ${argv.join(" ")} failed: ${stderr.trim().slice(-2048) || error.message}`));
      else resolve();
    });
  });
}

export async function createSandbox(provider: SandboxProvider, spec: SandboxSpec, specPath: string, signal?: AbortSignal): Promise<Sandbox> {
  for (const mount of spec.mounts) {
    const stat = statSync(mount.path);
    if (realpathSync(mount.path) !== mount.path || stat.dev !== mount.dev || stat.ino !== mount.ino) throw new Error(`Sandbox mount changed since validation: ${mount.path}`);
  }
  const stale = existsSync(specPath);
  writeFileSync(specPath, JSON.stringify({ schemaVersion: "1", name: spec.name, workspace: spec.workspace,
    additionalWorkspaces: spec.mounts.filter((mount) => mount.path !== spec.workspace).map(({ path, readOnly }) => ({ path, readOnly })),
    env: spec.env }), { mode: 0o600 });
  const remove = () => runProvider(fillTemplate(provider.remove, { name: spec.name }), 120_000);
  if (stale) await remove().catch(() => {});
  try { await runProvider(fillTemplate(provider.create, { spec: specPath, name: spec.name }), 600_000, signal); }
  catch (error) { await remove().catch(() => {}); throw error; }
  let holds = 0, closed = false, removing = false;
  let finish!: (outcome: Promise<void>) => void;
  const removed = new Promise<void>((resolve) => { finish = resolve as (outcome: Promise<void>) => void; });
  removed.catch(() => {});
  const settle = () => {
    if (closed && !holds && !removing) { removing = true; finish(remove().then(() => rmSync(specPath, { force: true }))); }
  };
  return {
    name: spec.name,
    nodePath: provider.nodePath,
    hold: () => {
      if (closed) throw new Error(`Sandbox ${spec.name} is stopping`);
      holds++;
      let released = false;
      return () => { if (!released) { released = true; holds--; settle(); } };
    },
    close: () => { closed = true; settle(); return removed; },
    command: (cwd, argv, env) => {
      const [command, ...args] = fillTemplate(provider.exec, { name: spec.name, cwd });
      return { command: command!, args: [...args, provider.nodePath, "-e", sandboxSupervisorSource, "--", "env",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...argv] };
    },
  };
}
