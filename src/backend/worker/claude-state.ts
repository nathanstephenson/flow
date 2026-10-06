import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Keep projects durable in the Backend Session's state. CLAUDE_SECURESTORAGE_CONFIG_DIR
 * separates Claude's auth root (credential storage AND refresh/write locks) from its config /
 * transcript root on Linux and macOS. Unrestricted launches keep the ordinary shared auth root;
 * restricted launches already bind projects into a narrowly staged config root and must NEVER
 * receive the host auth override.
 */
export function prepareClaudeState(stateDir: string | undefined, inherited: NodeJS.ProcessEnv = process.env, scope = process.cwd()): {
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
  // Match the CLI: relative config roots are Scope-relative, and literal ~ is not
  // expanded. Restricted callers reject nonabsolute host roots before reaching here.
  const source = resolve(scope, inherited.CLAUDE_CONFIG_DIR || join(home, ".claude"));
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
    for (const name of [".config.json", ".claude.json"]) {
      const from = name === ".claude.json" && !existsSync(join(source, name)) ? join(home, name) : join(source, name);
      if (existsSync(from) && statSync(from).isFile()) copyFileSync(from, join(config, name));
    }
    for (const name of ["CLAUDE.md", "settings.json", "commands", "skills", "agents", "rules", "plugins"]) {
      const from = join(source, name);
      if (existsSync(from)) symlinkSync(from, join(config, name), statSync(from).isDirectory() ? "dir" : "file");
    }
    const env: NodeJS.ProcessEnv = { ...inherited, CLAUDE_CONFIG_DIR: config,
      // Use the original spelling, including the empty default: macOS hashes this string for
      // its keychain service identity. Linux resolves it to the original credential directory.
      // Both the atomic credential replacement and all refresh/write locks use this ROOT, not
      // a credential-file link or a copy that would lose token rotation on worker disposal.
      CLAUDE_SECURESTORAGE_CONFIG_DIR: inherited.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? inherited.CLAUDE_CONFIG_DIR ?? "",
    };
    return { env, cleanup };
  } catch (error) { cleanup(); throw error; }
}
