import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentBackend } from '../../src/backend/types.ts';

const backend: AgentBackend = {
  name: 'pi-auth-fixture',
  async create(options) {
    return {
      capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
      resumeToken: () => undefined,
      async prompt(text) {
        const result = text === 'metadata' ? await options.piAuth?.snapshot()
          : text === 'files' ? existsSync(join(process.env.PI_CODING_AGENT_DIR!, 'auth.json'))
          : await options.piAuth?.resolve(text);
        options.emit({ type: 'message', id: text, text: JSON.stringify(result), final: true });
      },
      async abort() {},
      async setModel() {},
      async setEffort() {},
      async dispose() {},
    };
  },
};
export default backend;
