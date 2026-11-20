import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentBackend, BackendSession } from '../backend/types.ts';
import { workflowBuilderFolder } from '../isolation/shared-sandbox.ts';

export class PiModelProbeCache {
  private catalog: Buffer | undefined;
  private generation = 0;

  wrap(backend: AgentBackend): AgentBackend {
    return { name: backend.name, create: async options => {
      const generation = ++this.generation;
      const root = mkdtempSync(join(workflowBuilderFolder(), 'flow-model-probe-'));
      const stateDir = join(root, 'backend');
      const path = join(stateDir, 'models-store.json');
      let session: BackendSession | undefined;
      try {
        mkdirSync(stateDir, { mode: 0o700 });
        if (this.catalog) writeFileSync(path, this.catalog, { mode: 0o600 });
        session = await backend.create({ ...options, stateDir });
        if (generation === this.generation && existsSync(path)) this.catalog = readFileSync(path);
        const dispose = session.dispose.bind(session);
        session.dispose = async () => {
          await dispose();
          rmSync(root, { recursive: true, force: true });
        };
        return session;
      } catch (error) {
        await session?.dispose();
        rmSync(root, { recursive: true, force: true });
        throw error;
      }
    } };
  }
}
