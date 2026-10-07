import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

function ownedProjects(stateDir: string): string {
  const projects = join(realpathSync(stateDir), "claude-projects");
  if (!existsSync(projects)) mkdirSync(projects, { mode: 0o700 });
  if (!lstatSync(projects).isDirectory() || realpathSync(projects) !== projects) {
    throw new Error("Unsafe Claude backend transcript directory");
  }
  return projects;
}

/** Claude's Scope key, including the CLI's suffix for paths longer than 200 characters. */
function projectKey(scope: string): string {
  const key = scope.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= 200) return key;
  let hash = 0;
  for (let i = 0; i < scope.length; i++) hash = ((hash << 5) - hash + scope.charCodeAt(i)) | 0;
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Copy only regular, unlinked records; never follow a link into other host state. */
function copyRecord(source: string, destination: string, from = source): string {
  const before = lstatSync(from);
  if (realpathSync(source) !== source || (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))) {
    throw new Error("Unsafe legacy Claude conversation record");
  }
  const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const pinned = fstatSync(fd);
    const descriptor = process.platform === "linux" ? `/proc/self/fd/${fd}` : source;
    if (pinned.dev !== before.dev || pinned.ino !== before.ino || realpathSync(descriptor) !== source) {
      throw new Error("Legacy Claude conversation record changed during migration");
    }
    const hash = createHash("sha256");
    if (before.isDirectory()) {
      mkdirSync(destination, { mode: 0o700 });
      hash.update("directory\0");
      // Linux copies through pinned directories, never through mutable ancestors. Elsewhere,
      // no-follow opens and a post-copy identity check refuse a changed tree before publication.
      for (const name of readdirSync(descriptor).sort()) {
        hash.update(JSON.stringify([name, copyRecord(join(source, name), join(destination, name), join(descriptor, name))]));
      }
    } else {
      const content = readFileSync(fd);
      writeFileSync(destination, content, { mode: 0o600, flag: "wx" });
      hash.update("file\0").update(content);
    }
    const after = lstatSync(source);
    if (after.dev !== pinned.dev || after.ino !== pinned.ino || realpathSync(source) !== source) {
      throw new Error("Legacy Claude conversation record changed during migration");
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

/**
 * Pre-isolation Claude wrote Conversation Context into the global projects tree. On Revive,
 * import only the saved UUID under this Scope, plus its UUID-owned sidecars (Subagents and tool
 * results). Never import another conversation, credentials, or overwrite a newer owned record.
 * This runs on the host before restricted launch: workers must not gain access to global state.
 */
export function migrateLegacyClaudeState(stateDir: string | undefined, inherited: NodeJS.ProcessEnv,
  scope: string, resume: string | undefined): void {
  if (!stateDir || !resume) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resume)) {
    throw new Error("Invalid Claude resume ID");
  }
  const projects = ownedProjects(stateDir);
  const key = projectKey(scope);
  const destination = join(projects, key);
  const record = `${resume}.jsonl`;
  if (existsSync(destination) && (!lstatSync(destination).isDirectory() || realpathSync(destination) !== destination)) {
    throw new Error("Unsafe Claude backend project directory");
  }
  // Do not consult global storage at all once the owned copy exists.
  const owned = join(destination, record);
  if (existsSync(owned)) {
    if (!lstatSync(owned).isFile() || realpathSync(owned) !== owned) throw new Error("Unsafe Claude backend conversation record");
    return;
  }
  const config = resolve(scope, inherited.CLAUDE_CONFIG_DIR || join(inherited.HOME ?? homedir(), ".claude"));
  if (!existsSync(config)) return;
  const source = join(realpathSync(config), "projects", key);
  if (!existsSync(join(source, record))) return;
  if (realpathSync(source) !== source) throw new Error("Unsafe legacy Claude project directory");
  const staged = mkdtempSync(join(projects, ".migrate-"));
  let movedSidecars = false;
  try {
    copyRecord(join(source, record), join(staged, record));
    const sidecars = existsSync(join(source, resume)) ? copyRecord(join(source, resume), join(staged, resume)) : undefined;
    if (!existsSync(destination)) {
      // The ordinary legacy case publishes the transcript and all sidecars together.
      renameSync(staged, destination);
      return;
    }
    if (sidecars !== undefined) {
      if (existsSync(join(destination, resume))) {
        // A restart between sidecar publication and the atomic main-record link is retryable.
        // Reuse only an exact match; never discard or overwrite potentially newer owned state.
        if (copyRecord(join(destination, resume), join(staged, ".existing-sidecars")) !== sidecars) {
          throw new Error("Claude conversation sidecars differ from the legacy record without their transcript");
        }
      } else {
        renameSync(join(staged, resume), join(destination, resume));
        movedSidecars = true;
      }
    }
    // Publish a complete main record last, atomically and without replacing an existing one.
    linkSync(join(staged, record), join(destination, record));
  } catch (error) {
    if (movedSidecars) rmSync(join(destination, resume), { recursive: true, force: true });
    throw error;
  } finally { rmSync(staged, { recursive: true, force: true }); }
}

/**
 * Keep projects durable in the Backend Session's state. CLAUDE_SECURESTORAGE_CONFIG_DIR
 * separates Claude's auth root (credential storage AND refresh/write locks) from its config /
 * transcript root on Linux and macOS. Unrestricted launches keep the ordinary shared auth root;
 * restricted launches already bind projects into a narrowly staged config root and must NEVER
 * receive the host auth override.
 */
export function prepareClaudeState(stateDir: string | undefined, inherited: NodeJS.ProcessEnv = process.env, scope = process.cwd(), resume?: string): {
  env: NodeJS.ProcessEnv;
  cleanup(): void;
} {
  if (!stateDir) return { env: inherited, cleanup() {} };
  migrateLegacyClaudeState(stateDir, inherited, scope, resume);
  const projects = ownedProjects(stateDir);
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
