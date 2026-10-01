import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { DEFAULT_WORKFLOW_RUNTIME, type WorkflowRuntimeSettings } from '../protocol/settings.ts';

export function workflowRuntimeOptions(settings: WorkflowRuntimeSettings = DEFAULT_WORKFLOW_RUNTIME, path?: string) {
  const discover = (name: string, search: string): string | undefined => {
    for (const directory of search.split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
    return undefined;
  };
  return {
    nodePath: settings.nodePath ?? discover('node', path ?? process.env.PATH ?? ''),
  };
}
