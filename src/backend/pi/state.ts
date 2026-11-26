import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Point pi session files in `stateDir` from Scope `from` to Scope `to`. pi reopens a session only when its header `cwd` matches. */
export function relocatePiState(stateDir: string, from: string, to: string): void {
  for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(stateDir, entry.name);
    const content = readFileSync(path, "utf8");
    const end = content.indexOf("\n");
    const header = JSON.parse(end < 0 ? content : content.slice(0, end)) as { type?: string; cwd?: string };
    if (header.type !== "session" || header.cwd !== from) continue;
    const temporary = `${path}.relocate`;
    writeFileSync(temporary, JSON.stringify({ ...header, cwd: to }) + (end < 0 ? "" : content.slice(end)), { mode: 0o600 });
    renameSync(temporary, path);
  }
}

export const USER_MESSAGE_MAP = "flow-user-messages.json";

/** Copy the most recent pi session file and its user message map for a Fork, bound to Scope `scope`. */
export function forkPiState(from: string, to: string, scope: string): string {
  const files = readdirSync(from, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  const latest = files.map((entry) => entry.name).sort((a, b) => statSync(join(from, b)).mtimeMs - statSync(join(from, a)).mtimeMs)[0];
  if (!latest) throw new Error("No pi session to fork");
  writePiSession(join(to, latest), readFileSync(join(from, latest), "utf8"), scope);
  if (existsSync(join(from, USER_MESSAGE_MAP))) copyFileSync(join(from, USER_MESSAGE_MAP), join(to, USER_MESSAGE_MAP));
  return to;
}

/** Write pi session file `content` to a new file at `path`, its header bound to Scope `scope`. */
export function writePiSession(path: string, content: string, scope: string): void {
  const end = content.indexOf("\n");
  const header = JSON.parse(end < 0 ? content : content.slice(0, end)) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...header, cwd: scope }) + (end < 0 ? "" : content.slice(end)), { mode: 0o600, flag: "wx" });
}
