import type { Entry } from "../../../src/client/reduce.ts";
import { isWithin, producerKey, subagentParents } from "../../../src/client/subagent-tree.ts";
import { toolSummary } from "../../../src/client/tool-summary.ts";

/**
 * One piece of work running beside the turn, as the Composer's card stack shows it.
 *
 * A card stands for running work with no running Subagent above it; `nested` counts the running work
 * below a Subagent's card.
 *
 * `key` is where clicking it goes: a Subagent's Entry key, which the Agents tab opens, or the key of
 * the tool row that launched a Background Call, which the transcript scrolls to. A Subagent's Call
 * carries that Subagent's key in `subagent`, because its tool row is in the Agents tab instead.
 */
export type RunningWork =
  | { kind: "agent"; key: string; name: string; detail?: string; nested: NestedWork }
  | { kind: "call"; key: string; tool: string; detail?: string; subagent?: string };

/** Running Subagents below one, at any depth, and running Background Calls it or they started. */
export type NestedWork = { agents: number; calls: number };

/**
 * What is running, oldest first. A Subagent's Background Call has its own card only once no Subagent
 * above it is still running.
 * A Call shows only after the agent has written to the user since launching it; until then its own
 * row is the latest thing in the transcript, and a card would repeat it.
 */
export function runningWork(keys: readonly string[], getEntry: (key: string) => Entry | undefined): RunningWork[] {
  const work: RunningWork[] = [];
  const parents = subagentParents(keys, getEntry);
  const lastMessage = keys.findLastIndex((key) => {
    const entry = getEntry(key);
    return entry?.kind === "assistant" && !entry.producer;
  });
  for (const key of keys) {
    const entry = getEntry(key);
    if (entry?.kind === "subagent" && live(entry) && !underLive(getEntry, parents, parents.get(key))) {
      work.push({
        kind: "agent",
        key,
        name: entry.name,
        ...(entry.description ? { detail: entry.description } : {}),
        nested: nestedWork(keys, getEntry, parents, key),
      });
    } else if (
      entry?.kind === "background_call" && entry.status === "running" &&
      (entry.producer ? !underLive(getEntry, parents, producerKey(entry)) : keys.indexOf(`tool:${entry.id}`) < lastMessage)
    ) {
      const tool = getEntry(`tool:${entry.id}`);
      const detail = tool?.kind === "tool" ? toolSummary(tool.input) : undefined;
      const subagent = producerKey(entry);
      work.push({ kind: "call", key: `tool:${entry.id}`, tool: entry.tool, ...(detail ? { detail } : {}), ...(subagent ? { subagent } : {}) });
    }
  }
  return work;
}

function live(entry: Extract<Entry, { kind: "subagent" }>): boolean {
  return entry.status === "running" || entry.status === "waiting";
}

function underLive(
  getEntry: (key: string) => Entry | undefined,
  parents: ReadonlyMap<string, string | undefined>,
  start: string | undefined,
): boolean {
  for (let at = start; at !== undefined; at = parents.get(at)) {
    const entry = getEntry(at);
    if (entry?.kind === "subagent" && live(entry)) return true;
  }
  return false;
}

function nestedWork(
  keys: readonly string[],
  getEntry: (key: string) => Entry | undefined,
  parents: ReadonlyMap<string, string | undefined>,
  root: string,
): NestedWork {
  const nested = { agents: 0, calls: 0 };
  for (const key of keys) {
    const entry = getEntry(key);
    if (entry?.kind === "subagent" && key !== root && live(entry) && isWithin(parents, key, root)) nested.agents++;
    if (entry?.kind === "background_call" && entry.status === "running" && isWithin(parents, producerKey(entry), root)) nested.calls++;
  }
  return nested;
}

/** "2 agents · 1 call running", or undefined when nothing runs below. */
export function nestedLabel({ agents, calls }: NestedWork): string | undefined {
  const parts = [
    ...(agents > 0 ? [`${agents} agent${agents === 1 ? "" : "s"}`] : []),
    ...(calls > 0 ? [`${calls} call${calls === 1 ? "" : "s"}`] : []),
  ];
  return parts.length === 0 ? undefined : `${parts.join(" · ")} running`;
}
