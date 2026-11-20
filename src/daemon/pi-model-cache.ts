import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
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
      let fd: number | undefined;
      try {
        mkdirSync(stateDir, { mode: 0o700 });
        fd = openSync(path, 'wx+', 0o600);
        writeFileSync(fd, this.catalog ?? '{}');
        session = await backend.create({ ...options, stateDir });
        const stat = fstatSync(fd);
        if (generation === this.generation && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024) {
          const bytes = Buffer.alloc(stat.size);
          const size = readSync(fd, bytes, 0, bytes.length, 0);
          this.catalog = bytes.subarray(0, size);
        }
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
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    } };
  }
}
