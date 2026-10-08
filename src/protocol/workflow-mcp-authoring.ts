import type { McpToolDiscovery, McpToolSnapshot } from './workflows.ts';

export type WorkflowMcpConnections = {
  scope: string;
  connections: Array<{ id: string; name: string; transport: 'stdio' | 'http'; enabledByDefault: boolean }>;
};

/** Metadata only. No credentials, transport configuration, or callable handles. */
export type WorkflowMcpCatalogue = WorkflowMcpConnections & {
  /** Exact directory identity captured before discovery, never derived from a later path lookup. */
  scopeIdentity: string;
  tools: McpToolSnapshot[];
  errors: Array<{ connectionId: string; connectionName: string; toolName?: string; message: string }>;
};

export interface WorkflowMcpAuthoring {
  connections(projectId?: string): WorkflowMcpConnections | Promise<WorkflowMcpConnections>;
  discover(projectId: string | undefined, connectionId: string, refresh?: boolean): Promise<McpToolDiscovery>;
  catalogue(projectId?: string, expectedScope?: Pick<WorkflowMcpCatalogue, 'scope' | 'scopeIdentity'>): Promise<WorkflowMcpCatalogue>;
  hasActiveWork(): boolean;
  shutdown(): Promise<void>;
}
