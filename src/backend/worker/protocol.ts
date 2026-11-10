import type { BackendCreateOptions, BackendSession, WorkflowSubagentOptions } from "../types.ts";
import type { McpTool } from "../mcp.ts";
import type { Capabilities } from "../../protocol/events.ts";

export type McpToolMetadata = Omit<McpTool, "call">;
export type CreateMetadata = Omit<BackendCreateOptions, "emit" | "mcp" | "workflow" | "workflowBuilder" | "sessionTools" | "onFailure" | "signal"> & {
  /** Only instructions cross the worker channel; the three callbacks remain in the host. */
  workflowBuilderInstructions?: string;
  mcpTools?: McpToolMetadata[];
  mcpConnectionIds?: string[];
  /** Sandbox mode (ADR 0033): definitions for MCP clients that run in this worker. */
  mcpSandbox?: import("../../protocol/mcp.ts").McpConnection[];
  workflowEnabled: boolean;
  /** Host callbacks stay in the Session Host; only their availability crosses IPC. */
  sessionToolsEnabled: boolean;
  /** Trusted launcher configuration, never accepted from model RPC. */
  backendModule?: string;
  backend?: "pi" | "claude";
};
export type WorkflowMetadata = Omit<WorkflowSubagentOptions, "emit">;
export type SessionSnapshot = {
  capabilities: Capabilities;
  resume: string | undefined;
  methods: string[];
  /** Worker durations in ms, only in the create reply: process start to create, backend import, backend create. */
  startup?: { ready: number; import: number; create: number };
};
export function snapshot(session: BackendSession): SessionSnapshot {
  return {
    capabilities: session.capabilities,
    resume: session.resumeToken(),
    methods: ["refreshMcp", "startWorkflowSubagent", "compact", "skills", "answerEnquiry", "answerPermission", "setPermissionMode"]
      .filter((method) => typeof (session as unknown as Record<string, unknown>)[method] === "function"),
  };
}
export function mcpMetadata(mcp: BackendCreateOptions["mcp"]): McpToolMetadata[] {
  return (mcp?.tools() ?? []).map(({ name, connectionId, definition, serverIdentity }) => ({ name, connectionId, definition, serverIdentity }));
}
