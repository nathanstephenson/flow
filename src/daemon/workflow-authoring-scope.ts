import { realpathSync, statSync } from 'node:fs';
import type { ConfigStore } from './config-store.ts';
import { includedProjects } from './projects.ts';

export function workflowAuthoringScope(config: Pick<ConfigStore, 'projectRoot' | 'projectInclude'>, fallback: string, projectId?: string): string {
  let scope = config.projectRoot() ?? fallback;
  if (projectId !== undefined) {
    const project = includedProjects(config.projectRoot(), config.projectInclude()).find(project => project.path === projectId);
    if (!project || project.missing) throw new Error('Workflow Project is not opted in');
    scope = project.path;
  }
  const canonical = realpathSync(scope);
  if (!statSync(canonical).isDirectory()) throw new Error('Workflow Scope must be a directory');
  return canonical;
}
