import { z } from 'zod';
import type { Json, McpToolSnapshot } from '../protocol/workflows.ts';
import { validateJsonSchema } from './json-schema.ts';

export const MCP_RESULT_BYTES = 100_000;
export function boundedMcpValue(value: unknown): Json {
  const json = z.json().parse(value) as Json;
  if (new TextEncoder().encode(JSON.stringify(json)).byteLength > MCP_RESULT_BYTES) throw new Error('MCP result exceeds 100,000 bytes; no output was retained. Remote effects may already have occurred.');
  return json;
}
export function validateMcpOutput(tool: McpToolSnapshot, value: unknown): Json {
  const json = boundedMcpValue(value);
  const envelope = z.object({ structuredContent: z.json(), content: z.array(z.object({ type: z.string() }).passthrough()) }).strict().parse(json);
  if (tool.outputSchema !== undefined) validateJsonSchema(tool.outputSchema, envelope.structuredContent as Json);
  return json;
}
