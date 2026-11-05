import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
