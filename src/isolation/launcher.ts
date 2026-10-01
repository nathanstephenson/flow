import { isSea } from "node:sea";
import { workerCommand } from "../backend/worker/launcher.ts";
import type { FilesystemIsolation } from "./filesystem.ts";

const flag = "--flow-isolation-launch";

/** The MCP SDK cannot pass mount descriptors. A trusted, non-interactive supervisor passes them
 * to Bubblewrap, sharing stdio verbatim. It never executes server code outside the boundary. */
export function filesystemStdioLaunch(isolation: FilesystemIsolation): { command: string; args: string[] } {
  const payload = JSON.stringify({ command: isolation.command, args: isolation.args,
    sources: isolation.stdioFds.map((fd) => `/proc/${process.pid}/fd/${fd}`) });
  if (isSea()) {
    const plan = workerCommand();
    return { command: plan.command, args: [flag, payload] };
  }
  // Use already-loaded code, not a disk entry a writable Project could replace before launch.
  const program = `(${runFilesystemLauncher.toString()})().catch(error=>{console.error(error.message);process.exitCode=1})`;
  return { command: process.execPath, args: ["-e", program, payload] };
}

export function isFilesystemLauncher(): boolean { return process.argv.includes(flag); }

export async function runFilesystemLauncher(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { closeSync, constants, openSync } = await import("node:fs");
  const spec = JSON.parse(process.argv.at(-1)!) as { command: string; args: string[]; sources: string[] };
  if (typeof spec.command !== "string" || !Array.isArray(spec.args) || !spec.args.every((value) => typeof value === "string") ||
    !Array.isArray(spec.sources) || !spec.sources.every((value) => typeof value === "string" && /^\/proc\/\d+\/fd\/\d+$/.test(value))) {
    throw new Error("Invalid filesystem launch specification");
  }
  const fds: number[] = [];
  try {
    for (const source of spec.sources) fds.push(openSync(source, constants.O_RDONLY));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(spec.command, spec.args, { env: process.env, stdio: [0, 1, 2, ...fds] });
      child.once("error", reject);
      child.once("close", (code) => { process.exitCode = code ?? 1; resolve(); });
    });
  } finally { for (const fd of fds) closeSync(fd); }
}
