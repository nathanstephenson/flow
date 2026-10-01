import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude has one config root for credentials/resources AND project transcripts; the SDK has no
 * separate local transcript-root option. Keep only projects durable in the Backend Session's
 * state. Restricted launches already bind this tree into a narrowly staged config root: reuse
 * that view, never replace it with links to the host credential store.
 */
export function prepareClaudeState(stateDir: string | undefined, inherited: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
  cleanup(): void;
} {
  if (!stateDir) return { env: inherited, cleanup() {} };
  const backend = realpathSync(stateDir);
  const projects = join(backend, "claude-projects");
  if (!existsSync(projects)) mkdirSync(projects, { mode: 0o700 });
  if (!lstatSync(projects).isDirectory() || realpathSync(projects) !== projects) {
    throw new Error("Unsafe Claude backend transcript directory");
  }
  const home = inherited.HOME ?? homedir();
  const configured = inherited.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const source = resolve(configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured);
  const currentProjects = join(source, "projects");
  if (existsSync(currentProjects)) {
    // Bind mounts have different realpath strings, but identify the same owned directory.
    const current = statSync(currentProjects), owned = statSync(projects);
    if (current.dev === owned.dev && current.ino === owned.ino) return { env: inherited, cleanup() {} };
  }

  // Unrestricted config view. Do not alter the user's global projects link, copy any global
  // transcripts, or persist credentials in backend state (which restricted workers can read).
  const config = mkdtempSync(join(tmpdir(), "flow-claude-config-"));
  const cleanup = () => rmSync(config, { recursive: true, force: true });
  try {
    symlinkSync(projects, join(config, "projects"), "dir");
    for (const name of [".credentials.json", ".config.json", ".claude.json"]) {
      const from = name === ".claude.json" && !existsSync(join(source, name)) ? join(home, name) : join(source, name);
      if (existsSync(from) && statSync(from).isFile()) copyFileSync(from, join(config, name));
    }
    for (const name of ["CLAUDE.md", "settings.json", "commands", "skills", "agents", "rules", "plugins"]) {
      const from = join(source, name);
      if (existsSync(from)) symlinkSync(from, join(config, name), statSync(from).isDirectory() ? "dir" : "file");
    }
    const env: NodeJS.ProcessEnv = { ...inherited, CLAUDE_CONFIG_DIR: config };
    // macOS keys its credential service by config root. Preserve the original service only for
    // this unrestricted view; a restricted view returned above never receives this override.
    if (process.platform === "darwin") env.CLAUDE_SECURESTORAGE_CONFIG_DIR = inherited.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? inherited.CLAUDE_CONFIG_DIR ?? "";
    return { env, cleanup };
  } catch (error) { cleanup(); throw error; }
}
