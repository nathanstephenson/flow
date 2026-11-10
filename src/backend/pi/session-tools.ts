import { Type } from "typebox";
import { z } from "zod";
import {
  sessionListInput, sessionInspectInput, sessionCreateInput, sessionSendInput,
  sessionListDescription, sessionInspectDescription, sessionCreateDescription, sessionSendDescription,
  type SessionTools,
} from "../session-tools.ts";

export function piSessionTools(sessions?: SessionTools) {
  if (!sessions) return [];
  return [
    { name: "session_list", label: "List Agent Sessions", description: sessionListDescription,
      parameters: Type.Unsafe<z.input<typeof sessionListInput>>(z.toJSONSchema(sessionListInput, { io: "input" })),
      execute: async (_id: string, input: z.input<typeof sessionListInput>) => ({ content: [{ type: "text" as const, text: JSON.stringify(await sessions.list(input)) }], details: {} }) },
    { name: "session_inspect", label: "Inspect Agent Session", description: sessionInspectDescription,
      parameters: Type.Unsafe<z.input<typeof sessionInspectInput>>(z.toJSONSchema(sessionInspectInput, { io: "input" })),
      execute: async (_id: string, input: z.input<typeof sessionInspectInput>) => ({ content: [{ type: "text" as const, text: JSON.stringify(await sessions.inspect(input)) }], details: {} }) },
    { name: "session_create", label: "Create Agent Session", description: sessionCreateDescription,
      parameters: Type.Unsafe<z.input<typeof sessionCreateInput>>(z.toJSONSchema(sessionCreateInput, { io: "input" })),
      execute: async (_id: string, input: z.input<typeof sessionCreateInput>, signal?: AbortSignal) => ({ content: [{ type: "text" as const, text: JSON.stringify(await sessions.create(input, signal)) }], details: {} }) },
    { name: "session_send", label: "Send to Agent Session", description: sessionSendDescription,
      parameters: Type.Unsafe<z.input<typeof sessionSendInput>>(z.toJSONSchema(sessionSendInput, { io: "input" })),
      execute: async (_id: string, input: z.input<typeof sessionSendInput>, signal?: AbortSignal) => ({ content: [{ type: "text" as const, text: JSON.stringify(await sessions.send(input, signal)) }], details: {} }) },
  ];
}
