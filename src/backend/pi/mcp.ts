import { Type } from "typebox";
import type { McpSession } from "../mcp.ts";

export function piMcpTools(mcp?: McpSession) {
  return (mcp?.tools() ?? []).map((tool) => ({
    name: tool.name,
    label: tool.definition.title ?? tool.definition.name,
    description: `${tool.definition.name}: ${tool.definition.description ?? "MCP tool"}`,
    parameters: Type.Unsafe<Record<string, unknown>>(
      tool.definition.inputSchema,
    ),
    execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
      const result = await tool.call(input as Record<string, unknown>, signal);
      const text =
        result.content
          .filter((block) => block.type !== "image")
          .map((block) =>
            block.type === "text" ? block.text : JSON.stringify(block),
          )
          .join("\n") ||
        (result.structuredContent
          ? JSON.stringify(result.structuredContent)
          : "");
      const output = text;
      if (result.isError) throw new Error(output);
      return {
        content: [
          ...(output ? [{ type: "text" as const, text: output }] : []),
          ...result.content
            .filter((block) => block.type === "image")
            .map((block) => ({
              type: "image" as const,
              data: block.data,
              mimeType: block.mimeType,
            })),
        ],
        details: {},
      };
    },
  }));
}
