import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentBackend } from "../../src/backend/types.ts";

/** Exercise Pi's resource discovery in a worker without credentials or a model call. */
const backend: AgentBackend = {
  name: "pi",
  async create(options) {
    const loader = new DefaultResourceLoader({ cwd: options.scope, agentDir: process.env.PI_CODING_AGENT_DIR!,
      noExtensions: true });
    return {
      capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
      resumeToken: () => undefined,
      async prompt() {},
      async abort() {},
      async setModel() {},
      async setEffort() {},
      async dispose() {},
      async skills() {
        await loader.reload();
        return [...loader.getSkills().skills, ...loader.getPrompts().prompts]
          .map(({ name, description }) => ({ name, description }));
      },
    };
  },
};
export default backend;
