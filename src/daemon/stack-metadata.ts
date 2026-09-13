import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { run, GIT_READ_TIMEOUT_MS } from "./git.ts";

type Branch = { branch: string; pullRequest?: { number: number; merged?: boolean } };
export type LocalStack = { id?: string; trunk: Branch; branches: Branch[] };

export async function localStacks(scope: string): Promise<LocalStack[]> {
  const path = await run(scope, ["rev-parse", "--git-path", "gh-stack"], GIT_READ_TIMEOUT_MS);
  if (!path.ok) throw new Error(path.failure.message);
  let raw: string;
  try { raw = await readFile(resolve(scope, path.value.trim()), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const data = JSON.parse(raw) as { schemaVersion: number; stacks: LocalStack[] };
  if (data.schemaVersion !== 1 || !Array.isArray(data.stacks) || data.stacks.some(s => !s.trunk || typeof s.trunk.branch !== "string" || !Array.isArray(s.branches) || s.branches.some(b => typeof b.branch !== "string"))) throw new Error("Invalid or unsupported gh stack metadata. Repair it with gh stack before publishing or syncing.");
  return data.stacks;
}

export async function localStack(scope: string, branch: string): Promise<LocalStack | undefined> {
  return (await localStacks(scope)).find(s => s.branches.some(b => b.branch === branch));
}
