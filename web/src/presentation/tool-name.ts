/** The MCP Connection name and tool name inside `mcp__<id>__<tool>`, for a configured connection. */
export function toolLabel(
  name: string,
  connections: readonly { id: string; name: string }[] | undefined,
): { connection: string; tool: string } | undefined {
  const match = (connections ?? [])
    .filter((connection) => name.startsWith(`mcp__${connection.id}__`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  return match && { connection: match.name, tool: name.slice(`mcp__${match.id}__`.length) };
}
