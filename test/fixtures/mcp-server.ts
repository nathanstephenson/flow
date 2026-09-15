import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1" });
server.registerTool(
  "echo",
  { inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
server.registerTool("fail", { inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "Fixture failure" }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
