import type { BackendCreateOptions, BackendSession, WorkflowSubagentOptions } from "../types.ts";
import type { McpTool } from "../mcp.ts";
import type { Capabilities } from "../../protocol/events.ts";

export type McpToolMetadata = Omit<McpTool, "call">;
export type CreateMetadata = Omit<BackendCreateOptions, "emit" | "mcp" | "workflow" | "onFailure"> & {
  mcpTools?: McpToolMetadata[];
  workflowEnabled: boolean;
  /** Trusted launcher configuration, never accepted from model RPC. */
  backendModule?: string;
};
export type WorkflowMetadata = Omit<WorkflowSubagentOptions, "emit">;
export type SessionSnapshot = {
  capabilities: Capabilities;
  resume: string | undefined;
  methods: string[];
};
export function snapshot(session: BackendSession): SessionSnapshot {
  return {
    capabilities: session.capabilities,
    resume: session.resumeToken(),
    methods: ["refreshMcp", "startWorkflowSubagent", "compact", "skills", "answerEnquiry", "answerPermission"]
      .filter((method) => typeof (session as unknown as Record<string, unknown>)[method] === "function"),
  };
}
export function mcpMetadata(mcp: BackendCreateOptions["mcp"]): McpToolMetadata[] {
  return (mcp?.tools() ?? []).map(({ name, connectionId, definition, serverIdentity }) => ({ name, connectionId, definition, serverIdentity }));
}
