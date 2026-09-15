import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { McpConnection } from '../protocol/mcp.ts';
import type { JsonSchema, McpToolSnapshot } from '../protocol/workflows.ts';
import type { McpTool } from '../backend/mcp.ts';
import { compileJsonSchema } from '../workflows/json-schema.ts';

export function connectionIdentity(connection: McpConnection): string {
  const config = connection.transport === 'stdio' ? [connection.id, connection.transport, connection.command, connection.args] : [connection.id, connection.transport, connection.url, connection.oauth];
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
export function snapshotTool(connection: McpConnection, tool: McpTool): McpToolSnapshot {
  const inputSchema = tool.definition.inputSchema as JsonSchema;
  const outputSchema = tool.definition.outputSchema as JsonSchema | undefined;
  compileJsonSchema(inputSchema);
  if (outputSchema !== undefined) compileJsonSchema(outputSchema);
  return { connectionId: connection.id, connectionName: connection.name, identity: connectionIdentity(connection), serverIdentity: tool.serverIdentity, toolName: tool.definition.name, inputSchema, ...(outputSchema === undefined ? {} : { outputSchema }) };
}
export function sameSchema(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}
