import type { Entry } from "../../../src/client/reduce.ts";
import { toolSummary } from "../../../src/client/tool-summary.ts";

/**
 * One piece of work running beside the turn, as the Composer's card stack shows it.
 *
 * `key` is where clicking it goes: a Subagent's Entry key, which the Agents tab opens, or the key of
 * the tool row that launched a Background Call, which the transcript scrolls to.
 */
export type RunningWork =
  | { kind: "agent"; key: string; name: string; detail?: string }
  | { kind: "call"; key: string; tool: string; detail?: string };

/** What is running, oldest first. Only the parent's own Background Calls: a Subagent's have no row here. */
export function runningWork(keys: readonly string[], getEntry: (key: string) => Entry | undefined): RunningWork[] {
  const work: RunningWork[] = [];
  for (const key of keys) {
    const entry = getEntry(key);
    if (entry?.kind === "subagent" && (entry.status === "running" || entry.status === "waiting")) {
      work.push({ kind: "agent", key, name: entry.name, ...(entry.description ? { detail: entry.description } : {}) });
    } else if (entry?.kind === "background_call" && entry.status === "running" && !entry.producer) {
      const tool = getEntry(`tool:${entry.id}`);
      const detail = tool?.kind === "tool" ? toolSummary(tool.input) : undefined;
      work.push({ kind: "call", key: `tool:${entry.id}`, tool: entry.tool, ...(detail ? { detail } : {}) });
    }
  }
  return work;
}
