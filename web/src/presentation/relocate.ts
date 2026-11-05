import type { Project } from "../../../src/protocol/projects.ts";

/** The Project whose folder name matches the repository segment of a Worktree Scope (`…/worktrees/<repo>/<branch>`). */
export function suggestedRepository(scope: string, projects: readonly Pick<Project, "path" | "name">[]): string | undefined {
  const repo = /\/worktrees\/([^/]+)\/[^/]+$/.exec(scope)?.[1];
  return repo === undefined ? undefined : projects.find((project) => project.name === repo)?.path;
}
