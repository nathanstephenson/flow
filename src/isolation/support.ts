import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareFilesystemIsolation, type FilesystemIsolation } from "./filesystem.ts";

export type FilesystemIsolationSupport = { supported: boolean; reason?: string };
export type FilesystemIsolationSupportOptions = {
  stateRoot: string;
  /** Test seams; production uses the actual platform and inherited environment. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};
export type FilesystemIsolationSupportDetector = (
  options: FilesystemIsolationSupportOptions,
) => Promise<FilesystemIsolationSupport>;

/**
 * Capability means an actual successful namespace/descriptor-mount launch, not an installed binary.
 * prepareFilesystemIsolation itself runs /bin/true through the complete policy before returning.
 * No credentials are staged, and the temporary Scope is separate from the real protected state root.
 * This is a startup decision only: each subsequent restricted launch still fails closed on error.
 */
export const detectFilesystemIsolationSupport: FilesystemIsolationSupportDetector = async (options) => {
  if ((options.platform ?? process.platform) !== "linux") {
    return { supported: false, reason: "Filesystem isolation requires Linux and Bubblewrap" };
  }
  let scope: string | undefined;
  let isolation: FilesystemIsolation | undefined;
  try {
    // Never use operator TMPDIR, which can point into protected host state or a writable Scope.
    scope = mkdtempSync(join("/tmp", "flow-isolation-support-"));
    isolation = await prepareFilesystemIsolation({
      scope, stateRoot: options.stateRoot, command: "/bin/true", args: [], credentials: "none",
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return { supported: true };
  } catch (error) {
    // The launch policy adds “unrestricted launch refused”; that is true for enabled launches,
    // not a capability explanation when automatic selection legitimately chooses unrestricted.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return { supported: false, reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    try { isolation?.cleanup(); }
    finally { if (scope !== undefined) rmSync(scope, { recursive: true, force: true }); }
  }
};
