import { z } from 'zod';
import type { Json, McpToolSnapshot } from '../protocol/workflows.ts';
import { validateJsonSchema } from './json-schema.ts';

export const MCP_RESULT_BYTES = 100_000;
const jsonSchema = z.json();
const envelopeSchema = z.object({
  structuredContent: jsonSchema,
  content: z.array(z.object({ type: z.string() }).catchall(jsonSchema)),
}).strict();
const encoder = new TextEncoder();

// Also used after redaction, which preserves JSON but can increase its size.
export function assertMcpResultSize(json: Json): void {
  if (encoder.encode(JSON.stringify(json)).byteLength > MCP_RESULT_BYTES) throw new Error('MCP result exceeds 100,000 bytes; no output was retained. Remote effects may already have occurred.');
}

export function boundedMcpValue(value: unknown): Json {
  const json = jsonSchema.parse(value) as Json;
  assertMcpResultSize(json);
  return json;
}

// Scheduler boundary: validate executor results and manually supplied outputs alike.
export function validateMcpOutput(tool: McpToolSnapshot, value: unknown): Json {
  const envelope = envelopeSchema.parse(value);
  assertMcpResultSize(envelope);
  if (tool.outputSchema !== undefined) validateJsonSchema(tool.outputSchema, envelope.structuredContent as Json);
  return envelope;
}
