import type { SessionSummary } from "../../../src/protocol/commands.ts";
import type { Project } from "../../../src/protocol/projects.ts";
import { projectName } from "../../../src/client/project-name.ts";

export function sessionProject(
  summary: Pick<SessionSummary, "scope" | "worktree">,
  projects: readonly Project[],
): Project | undefined {
  if (!summary.worktree) return projects.find((project) => project.path === summary.scope);
  const name = projectName(summary.scope, summary.worktree);
  return projects.find((project) => project.name === name);
}
