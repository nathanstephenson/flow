import type { McpToolDiscovery, McpToolListing, McpToolSnapshot } from './workflows.ts';

export type WorkflowMcpConnections = {
  scope: string;
  connections: Array<{ id: string; name: string; transport: 'stdio' | 'http'; enabledByDefault: boolean }>;
};

/** Metadata only. No credentials, transport configuration, or callable handles. */
export type WorkflowMcpCatalogue = WorkflowMcpConnections & {
  /** Exact directory identity captured before discovery, never derived from a later path lookup. */
  scopeIdentity: string;
  tools: McpToolListing[];
  errors: Array<{ connectionId: string; connectionName: string; toolName?: string; message: string }>;
};

export type WorkflowMcpDiscovery = { tools: McpToolListing[]; errors: McpToolDiscovery['errors'] };

export interface WorkflowMcpAuthoring {
  connections(projectId?: string): WorkflowMcpConnections | Promise<WorkflowMcpConnections>;
  discover(projectId: string | undefined, connectionId: string, refresh?: boolean): Promise<WorkflowMcpDiscovery>;
  catalogue(projectId?: string, expectedScope?: Pick<WorkflowMcpCatalogue, 'scope' | 'scopeIdentity'>): Promise<WorkflowMcpCatalogue>;
  /** One full snapshot from the discovery cache. Discovers again when the cached entry has expired. */
  tool(projectId: string | undefined, connectionId: string, toolName: string, expectedScope?: Pick<WorkflowMcpCatalogue, 'scope' | 'scopeIdentity'>): Promise<McpToolSnapshot>;
  hasActiveWork(): boolean;
  shutdown(): Promise<void>;
}
