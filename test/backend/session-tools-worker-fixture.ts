import type { AgentBackend } from "../../src/backend/types.ts";

export default {
  name: "session-tools-fixture",
  async create(options) {
    if ("sessionToolsEnabled" in options) throw new Error("IPC metadata leaked into adapter options");
    let controller: AbortController | undefined;
    return {
      capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
      resumeToken: () => undefined,
      async prompt(text) {
        if (text === "capabilities") {
          options.emit({ type: "message", id: "capabilities", text: JSON.stringify({
            sessionTools: !!options.sessionTools, workflowBuilder: !!options.workflowBuilder,
          }), final: true });
          return;
        }
        const { method, input } = JSON.parse(text) as { method: string; input: never };
        controller = new AbortController();
        let result: unknown;
        switch (method) {
          case "list": result = await options.sessionTools!.list(input); break;
          case "inspect": result = await options.sessionTools!.inspect(input); break;
          case "create": result = await options.sessionTools!.create(input, controller.signal); break;
          case "send": result = await options.sessionTools!.send(input, controller.signal); break;
          default: throw new Error("Unknown fixture method");
        }
        options.emit({ type: "message", id: "result", text: JSON.stringify(result), final: true });
      },
      async abort() { controller?.abort(); },
      async setModel() {}, async setEffort() {}, async dispose() { controller?.abort(); },
    };
  },
} satisfies AgentBackend;
