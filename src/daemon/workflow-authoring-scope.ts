import { lstatSync, realpathSync, statSync } from 'node:fs';
import type { ConfigStore } from './config-store.ts';
import { isAbsolute, join } from 'node:path';
import { expandHome } from './projects.ts';

export function workflowAuthoringScopePath(config: Pick<ConfigStore, 'projectRoot' | 'projectInclude'>, fallback: string, projectId?: string): string {
  const root = config.projectRoot();
  if (projectId === undefined) return expandHome(root ?? fallback);
  const base = root === undefined ? undefined : expandHome(root);
  for (const entry of config.projectInclude()) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const expanded = expandHome(trimmed);
    if (!isAbsolute(expanded) && base === undefined) continue;
    const path = (isAbsolute(expanded) ? expanded : join(base!, expanded))
      .replace(/\/+$/, '').replace(/\/\.(?=\/|$)/g, '') || '/';
    if (path === projectId) return path;
  }
  throw new Error('Workflow Project is not opted in');
}

export function workflowAuthoringScope(config: Pick<ConfigStore, 'projectRoot' | 'projectInclude'>, fallback: string, projectId?: string): string {
  const scope = workflowAuthoringScopePath(config, fallback, projectId);
  if (projectId !== undefined) {
    let directory = false;
    try { directory = statSync(scope).isDirectory(); } catch {}
    if (!directory) throw new Error('Workflow Project is not opted in');
  }
  const canonical = realpathSync(scope);
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
