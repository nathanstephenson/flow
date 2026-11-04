import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIMIT_BYTES = 1_000_000;
const KEPT_LINES = 2000;

/** One JSON line per Backend Session start or probe, in `<state root>/timings.jsonl`. */
export function recordTiming(root: string, record: { kind: string } & Record<string, unknown>): void {
  appendFileSync(join(root, "timings.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

export function trimTimings(root: string): void {
  const file = join(root, "timings.jsonl");
  if (!existsSync(file) || statSync(file).size <= LIMIT_BYTES) return;
  writeFileSync(file, readFileSync(file, "utf8").trim().split("\n").slice(-KEPT_LINES).join("\n") + "\n");
}
