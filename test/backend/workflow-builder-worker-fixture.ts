import type { AgentBackend } from "../../src/backend/types.ts";

export default {
  name: "builder-fixture",
  async create(options) {
    if (options.mcp || options.workflow) throw new Error("Builder inherited other host capabilities");
    const builder = options.workflowBuilder;
    if (!builder || typeof builder.instructions !== "string") throw new Error("Missing builder metadata");
    if (options.signal) throw new Error("Host startup signal leaked into worker metadata");
    if (builder.instructions === "delay-start") {
      await builder.read("startup-ready");
      await new Promise(() => {});
    }
    return {
      capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
      resumeToken: () => undefined,
      async prompt(text) {
        let result: string;
        if (text === "invalid") {
          try { await builder.read(123 as unknown as string); result = "unexpected success"; }
          catch (error) { result = String(error); }
        } else if (text === "error") {
          try { result = await builder.write("invalid"); }
          catch (error) { result = String(error); }
        } else {
          result = [builder.instructions, await builder.read("reference"), await builder.list("examples"), await builder.write("{\"name\":\"Draft\"}")].join("\n");
        }
        options.emit({ type: "message", id: "builder", text: result, final: true });
      },
      async refreshMcp() { throw new Error("Cannot refresh builder MCP"); },
      async abort() {}, async setModel() {}, async setEffort() {}, async dispose() {},
    };
  },
} satisfies AgentBackend;
