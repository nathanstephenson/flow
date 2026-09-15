import { createBashToolDefinition, createLocalBashOperations, defineTool, type SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Producer } from "../../protocol/events.ts";
import { callIdFor, type PiWork } from "./work.ts";

export function backgroundTools(scope: string, settings: SettingsManager, work: PiWork, producer?: Producer, endsWithSubagent = false, completeOutput = false): ToolDefinition[] {
  const shellPath = settings.getShellPath();
  const commandPrefix = settings.getShellCommandPrefix();
  const bash = createBashToolDefinition(scope, {
    ...(shellPath ? { shellPath } : {}), ...(commandPrefix ? { commandPrefix } : {}),
  });
  return [
    defineTool({
      name: "bash", label: bash.label,
      description: `${bash.description} Set run_in_background to return immediately; completion is reported automatically. Use bash_output to read progress and kill_shell to stop a Background Call.${endsWithSubagent ? " In this foreground Subagent, Background Calls stop when you return your final response." : ""}`,
      promptSnippet: bash.promptSnippet ?? "Execute bash commands",
      promptGuidelines: bash.promptGuidelines ?? [],
      parameters: Type.Object({ ...bash.parameters.properties, run_in_background: Type.Optional(Type.Boolean()) }),
      execute: async (id, input, signal, onUpdate, ctx) => {
        const execute: typeof bash.execute = async (id, input, signal, update, ctx) => {
          if (!completeOutput) return bash.execute(id, input, signal, update, ctx);
          // Capture before the SDK preview is truncated; the host redacts/persists this result.
          const chunks: Buffer[] = [];
          const operations = createLocalBashOperations(shellPath ? { shellPath } : undefined);
          const full = createBashToolDefinition(scope, {
            ...(commandPrefix ? { commandPrefix } : {}),
            operations: { exec: (command, cwd, options) => operations.exec(command, cwd, { ...options, onData: data => { chunks.push(Buffer.from(data)); options.onData(data); } }) },
          });
          try {
            const result = await full.execute(id, input, signal, update, ctx);
            return { ...result, content: [{ type: 'text' as const, text: Buffer.concat(chunks).toString('utf8') }], details: {} };
          } catch (error) {
            update?.({ content: [{ type: 'text' as const, text: Buffer.concat(chunks).toString('utf8') }], details: {} });
            throw error;
          }
        };
        if (!input.run_in_background) return execute(id, input, signal, onUpdate, ctx);
        const callId = callIdFor(id, producer);
        return work.run({ type: "background_call", callId, tool: "bash", ...(producer ? { producer } : {}) },
          (signal, update) => execute(id, input, signal, update, ctx), true, signal);
      },
    }),
    defineTool({
      name: "bash_output", label: "Background Call output",
      description: "Read the current state and bounded output of a Background Call using the callId from its launch receipt.",
      parameters: Type.Object({ call_id: Type.String() }),
      execute: async (_id, { call_id }) => work.read(call_id, producer),
    }),
    defineTool({
      name: "kill_shell", label: "Stop a Background Call",
      description: "Stop a Background Call and its process tree using the callId from its launch receipt.",
      parameters: Type.Object({ call_id: Type.String() }),
      execute: async (_id, { call_id }) => work.stop(call_id, producer),
    }),
  ];
}
