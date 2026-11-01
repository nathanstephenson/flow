import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type SandboxProvider = { version: 1; probe: string[]; create: string[]; exec: string[]; remove: string[] };
export type SandboxProbe = { nodePath: string; claudePath: string; claudeAuthDir?: string };
export type SandboxSupport =
  | { supported: true; path: string; provider: SandboxProvider; probe: SandboxProbe }
  | { supported: false; reason: string };
export type SandboxSupportDetector = (options: { stateRoot: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<SandboxSupport>;

const placeholders = { probe: [], create: ["{spec}"], exec: ["{name}", "{cwd}"], remove: ["{name}"] } as const;

export function sandboxUnavailable(): Error {
  return new Error("Sandbox isolation is unavailable; unrestricted launch refused");
}

export function sandboxProviderPath(stateRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.FLOW_SANDBOX_PROVIDER || join(stateRoot, "sandbox-provider.json");
}

export function parseSandboxProvider(text: string): SandboxProvider {
  const value = JSON.parse(text) as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || value.version !== 1) throw new Error("version must be 1");
  for (const [command, required] of Object.entries(placeholders)) {
    const template = value[command];
    if (!Array.isArray(template) || !template.length || !template.every((part) => typeof part === "string" && part.length)) {
      throw new Error(`${command} must be a non-empty array of strings`);
    }
    for (const part of template as string[]) {
      if (/^\{.*\}$/.test(part) && !(required as readonly string[]).includes(part)) throw new Error(`${command} has unknown placeholder ${part}`);
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

function parseProbe(stdout: string): SandboxProbe {
  const value = JSON.parse(stdout) as Record<string, unknown> | null;
  if (!value || value.ok !== true) throw new Error(typeof value?.reason === "string" ? value.reason : "probe did not report ok");
  for (const key of ["nodePath", "claudePath"] as const) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key])) throw new Error(`probe ${key} must be an absolute path`);
  }
  if (value.claudeAuthDir !== undefined && (typeof value.claudeAuthDir !== "string" || !isAbsolute(value.claudeAuthDir))) {
    throw new Error("probe claudeAuthDir must be an absolute path");
  }
  return { nodePath: value.nodePath as string, claudePath: value.claudePath as string,
    ...(value.claudeAuthDir === undefined ? {} : { claudeAuthDir: value.claudeAuthDir as string }) };
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
    execFile(command!, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        const probe = parseProbe(stdout);
        if (error) throw new Error(`probe reported ok but exited with ${error.code ?? error.signal}`);
        resolve({ supported: true, path, provider, probe });
      }
      catch (parseError) {
        const detail = stdout.trim() ? (parseError as Error).message : error ? `${error.message} ${stderr.trim().slice(-1024)}`.trim() : (parseError as Error).message;
        resolve({ supported: false, reason: `Sandbox provider probe failed: ${detail}` });
      }
    });
  });
};
