import { head, run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { gh, type Gh } from "./github.ts";
import { changes, changesText } from "./changes.ts";
import { resolveRepository } from "./repository.ts";

export const TOUR_INSTRUCTIONS = [
  "Give an in-depth tour of this branch's committed changes, with the diff shown for each change you discuss.",
  "Step through the functional implementation in the order it runs, not file by file.",
  "Include all important diffs. Put a short summary of the supporting changes at the bottom.",
  "The input has the branch, its base, the commits and the diff. Read files in the Scope only when the diff is not enough.",
  "Read only: do not edit, write, run commands or ask questions.",
  'Write the tour as markdown and return it as {"tour":"<markdown>"}.',
].join("\n");

export const TOUR_READ_TOOLS = ["Read", "Glob", "Grep", "read", "grep", "find", "ls"];

export async function tourInput(scope: string, github: Gh = gh): Promise<{ branch: string; head: string; repo: string; input: string }> {
  const branch = await head(scope);
  if (!branch.ok) throw new Error(branch.failure.message);
  if (branch.value.detached) throw new Error("HEAD is detached. Switch to a branch before you start a tour.");
  const sha = await run(scope, ["rev-parse", "HEAD"], GIT_READ_TIMEOUT_MS);
  if (!sha.ok) throw new Error(sha.failure.message);
  const repository = await resolveRepository(scope, branch.value.name, github);
  const listed = await changes(scope, "branch", undefined, github);
  if (listed.commits.length === 0) throw new Error("This branch has no committed changes to tour.");
  return {
    branch: branch.value.name,
    head: sha.value.trim(),
    repo: repository.head.repo,
    input: `Branch: ${branch.value.name}\nBase: ${listed.base}\n${await changesText(scope, "branch", undefined, undefined, github)}`,
  };
}

export function tourText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { tour?: unknown }).tour === "string") return (parsed as { tour: string }).tour;
  } catch {}
  return raw;
}
