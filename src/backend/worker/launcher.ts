import { spawn, type ChildProcess } from "node:child_process";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

/** A wrapper can replace command/args to enter a sandbox without changing the IPC contract. */
export type WorkerLaunchOptions = {
  command?: string;
  args?: string[];
  entry?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  /** Trusted host-selected working directory; never a worker/model supplied value. */
  cwd?: string;
  /** Host-owned mount descriptors consumed by the isolation launcher before worker exec. */
  stdioFds?: number[];
  shutdownTimeoutMs?: number;
  startupTimeoutMs?: number;
};

export function workerCommand(options: WorkerLaunchOptions = {}): { command: string; args: string[] } {
  const source = import.meta.url.endsWith(".ts");
  const entry = options.entry ?? fileURLToPath(new URL(source ? "./entry.ts" : "./entry.js", import.meta.url));
  const args = options.args ?? (isSea() && !options.entry
    ? ["--flow-backend-worker"]
    : [...(options.execArgv ?? (source ? ["--experimental-strip-types"] : [])), entry]);
  return { command: options.command ?? process.execPath, args };
}

export function launchWorker(options: WorkerLaunchOptions = {}) {
  const { command, args } = workerCommand(options);
  const child = spawn(command, args, {
    env: { ...process.env, ...options.env, FLOW_BACKEND_WORKER: "1" },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe", "ipc", ...(options.stdioFds ?? [])],
    serialization: "advanced",
  });
  // Drain diagnostics so a chatty SDK cannot block on stderr. Keep only a bounded failure tail.
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  let stopping: Promise<void> | undefined;
  return {
    child,
    exited,
    diagnostics: () => diagnostics.trim(),
    /** Await the process, then kill its entire process group if cooperative disposal stalled. */
    stop: (graceful: () => Promise<unknown>) => stopping ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const cooperative = Promise.resolve().then(graceful).catch(() => {}).then(() => exited);
        const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, options.shutdownTimeoutMs ?? 5000); });
        await Promise.race([cooperative, exited, timeout]);
        // Also clean up detached descendants after an unexpected exit of their leader.
        await killWorkerTree(child);
        await exited;
      } finally { clearTimeout(timer); }
    })(),
  };
}

export async function killWorkerTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}
