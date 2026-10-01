import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { DEFAULT_WORKFLOW_RUNTIME, type WorkflowRuntimeSettings } from '../protocol/settings.ts';

export function workflowRuntimeOptions(settings: WorkflowRuntimeSettings = DEFAULT_WORKFLOW_RUNTIME, path?: string) {
  const discover = (name: string, search: string): string | undefined => {
    for (const directory of search.split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, name);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
    }
    return undefined;
  };
  return {
    ...settings,
    nodePath: settings.nodePath ?? discover('node', path ?? process.env.PATH ?? ''),
    // npm adds writable Project .bin directories to PATH. Docker runs on the host, unlike the
    // restricted local Node probe: never let a model plant the auto-discovered client there.
    dockerPath: settings.dockerPath ?? discover('docker', path ?? '/usr/local/bin:/usr/bin:/bin'),
  };
}
