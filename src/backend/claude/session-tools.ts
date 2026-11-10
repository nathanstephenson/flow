import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  sessionListInput, sessionInspectInput, sessionCreateInput, sessionSendInput,
  sessionListDescription, sessionInspectDescription, sessionCreateDescription, sessionSendDescription,
  type SessionTools,
} from "../session-tools.ts";

export const SESSION_TOOL_PREFIX = "mcp__flow_sessions__";
export const claudeSessionReadTools = ["session_list", "session_inspect"].map(name => `${SESSION_TOOL_PREFIX}${name}`);

export function sessionToolsServer(sessions?: SessionTools) {
  if (!sessions) return {};
  return { flow_sessions: createSdkMcpServer({ name: "flow_sessions", alwaysLoad: true, tools: [
    tool("session_list", sessionListDescription, sessionListInput.shape, async input => ({ content: [{ type: "text", text: JSON.stringify(await sessions.list(input)) }] })),
    tool("session_inspect", sessionInspectDescription, sessionInspectInput.shape, async input => ({ content: [{ type: "text", text: JSON.stringify(await sessions.inspect(input)) }] })),
    tool("session_create", sessionCreateDescription, sessionCreateInput.shape, async (input, extra) => ({ content: [{ type: "text", text: JSON.stringify(await sessions.create(input, (extra as { signal?: AbortSignal } | undefined)?.signal)) }] })),
    tool("session_send", sessionSendDescription, sessionSendInput.shape, async (input, extra) => ({ content: [{ type: "text", text: JSON.stringify(await sessions.send(input, (extra as { signal?: AbortSignal } | undefined)?.signal)) }] })),
  ] }) };
}
