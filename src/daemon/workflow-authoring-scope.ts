import { lstatSync, realpathSync, statSync } from 'node:fs';
import type { ConfigStore } from './config-store.ts';
import { expandHome, includedProjects } from './projects.ts';

export function workflowAuthoringScope(config: Pick<ConfigStore, 'projectRoot' | 'projectInclude'>, fallback: string, projectId?: string): string {
  let scope = config.projectRoot() ?? fallback;
  if (projectId !== undefined) {
    const project = includedProjects(config.projectRoot(), config.projectInclude()).find(project => project.path === projectId);
    if (!project || project.missing) throw new Error('Workflow Project is not opted in');
    scope = project.path;
  }
  const canonical = realpathSync(expandHome(scope));
  if (!statSync(canonical).isDirectory()) throw new Error('Workflow Scope must be a directory');
  return canonical;
}

export type WorkflowAuthoringDirectory = { path: string; identity: string };

/** Pin directory identity as well as its canonical path; replacements must not reuse tools. */
export function workflowAuthoringDirectory(path: string): WorkflowAuthoringDirectory {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error('Workflow authoring Scope changed; discover again');
  return { path, identity: `${stat.dev}:${stat.ino}` };
}

export function checkWorkflowAuthoringDirectory(directory: WorkflowAuthoringDirectory): void {
  if (workflowAuthoringDirectory(directory.path).identity !== directory.identity)
    throw new Error('Workflow authoring Scope changed; discover again');
}
