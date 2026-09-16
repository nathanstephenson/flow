import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { McpConnection } from '../protocol/mcp.ts';
import type { JsonSchema, McpToolSnapshot } from '../protocol/workflows.ts';
import type { McpTool } from '../backend/mcp.ts';
import { compileJsonSchema } from '../workflows/json-schema.ts';

export function connectionIdentity(connection: McpConnection): string {
  // Headers join the hash only when there are some, so every identity recorded before headers
  // existed still matches and no saved MCP step needs reconfiguring.
  const config = connection.transport === 'stdio' ? [connection.id, connection.transport, connection.command, connection.args] : [connection.id, connection.transport, connection.url, connection.oauth, ...(Object.keys(connection.headers).length ? [connection.headers] : [])];
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
