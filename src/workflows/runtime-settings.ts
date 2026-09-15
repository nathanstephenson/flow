import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { DEFAULT_WORKFLOW_RUNTIME, type WorkflowRuntimeSettings } from '../protocol/settings.ts';

export function workflowRuntimeOptions(settings: WorkflowRuntimeSettings = DEFAULT_WORKFLOW_RUNTIME, path = process.env.PATH ?? '') {
  const discover = (name: string): string | undefined => {
    for (const directory of path.split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, name);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
    }
    return undefined;
  };
  return {
    ...settings,
    nodePath: settings.nodePath ?? discover('node'),
    dockerPath: settings.dockerPath ?? discover('docker'),
  };
}
