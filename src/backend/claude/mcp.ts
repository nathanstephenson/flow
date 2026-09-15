import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Query, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpSession } from "../mcp.ts";

const initializedStreams = new WeakSet<object>();

export async function refreshClaudeMcp(stream: Pick<Query, "setMcpServers" | "mcpServerStatus">, mcp?: McpSession, additional: Record<string, McpSdkServerConfigWithInstance> = {}): Promise<void> {
  const servers = { ...claudeMcpServers(mcp), ...additional };
  const deadline = Date.now() + 10_000;
  while (!initializedStreams.has(stream)) {
    const status = await stream.mcpServerStatus();
    const selected = Object.keys(servers).map((name) => status.find((entry) => entry.name === name));
    if (selected.every((entry) => entry && entry.status !== "pending")) {
      initializedStreams.add(stream);
      break;
    }
    if (Date.now() >= deadline) throw new Error("MCP tools could not be registered");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stream.setMcpServers({});
  const result = await stream.setMcpServers(servers);
  while (!Object.keys(result.errors).length) {
    const status = await stream.mcpServerStatus();
    const selected = Object.keys(servers).map((name) => status.find((entry) => entry.name === name));
    if (selected.every((entry) => entry?.status === "connected")) return;
    if (Date.now() >= deadline || selected.some((entry) => entry && entry.status !== "pending" && entry.status !== "connected")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stream.setMcpServers({});
  throw new Error("MCP tools could not be registered");
}

export function claudeMcpServers(
  mcp?: McpSession,
): Record<string, McpSdkServerConfigWithInstance> {
  return Object.fromEntries(
    (mcp?.connections ?? []).map((connection) => {
      const instance = new McpServer({ name: connection.id, version: "1.0.0" });
      instance.server.registerCapabilities({ tools: {} });
      const tools = () =>
        mcp!.tools().filter((tool) => tool.connectionId === connection.id);
      const localName = (name: string) =>
        name.slice(`mcp__${connection.id}__`.length);
      instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools().map((tool) => ({
          ...tool.definition,
          name: localName(tool.name),
        })),
      }));
      instance.server.setRequestHandler(
        CallToolRequestSchema,
        async (request, extra) => {
          const tool = tools().find(
            (tool) => localName(tool.name) === request.params.name,
          );
          if (!tool) throw new Error("MCP tool unavailable");
          return await tool.call(request.params.arguments ?? {}, extra.signal);
        },
      );
      return [
        connection.id,
        { type: "sdk" as const, name: connection.id, instance },
      ];
    }),
  );
}
