import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { Producer } from "../../protocol/events.ts";
import { EFFORT_ORDER } from "../effort.ts";
import { callIdFor, type PiWork, type ToolResult } from "./work.ts";

export const SUBAGENT_TOOL = "subagent";
const parameters = Type.Object({
  description: Type.String({ minLength: 1, description: "Short description of the delegated work" }),
  prompt: Type.String({ minLength: 1, description: "Complete instructions; the Subagent cannot see your conversation" }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ description: "Provider-qualified model id; defaults to the parent's model at launch" })),
  effort: Type.Optional(Type.String({ enum: EFFORT_ORDER, description: "Defaults to the parent's Effort at launch" })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Defaults to true. Set false only when your next action requires the result." })),
});
export type SubagentInput = Static<typeof parameters>;

export function subagentTool(work: PiWork, run: (id: string, input: SubagentInput, signal: AbortSignal) => Promise<ToolResult>, producer?: Producer) {
  return defineTool({
    name: SUBAGENT_TOOL,
    label: "Subagent",
    description: "Delegate work to a Subagent with its own Conversation Context. Subagents run in the background by default and report back automatically. Multiple Subagents may run concurrently. They cannot ask the human or create further Subagents.",
    promptSnippet: "Delegate independent work to Subagents",
    parameters,
    execute: async (id, input, signal) => {
      const subagentId = callIdFor(id, producer);
      return work.run({ type: "subagent", subagentId, name: input.name ?? "Subagent", description: input.description,
        ...(producer ? { producer } : {}) }, (childSignal) => run(subagentId, input, childSignal), input.run_in_background !== false, signal);
    },
  });
}
