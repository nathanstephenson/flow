import { z } from 'zod';
import type { Json, McpToolSnapshot } from '../protocol/workflows.ts';
import { compileJsonSchema, validateJsonSchema } from './json-schema.ts';

/** Keep tool and schema context at discovery, save and execution boundaries. */
export function validateMcpSchemas(tool: Pick<McpToolSnapshot, 'toolName' | 'inputSchema' | 'outputSchema'>): void {
  for (const field of ['inputSchema', 'outputSchema'] as const) {
    const schema = tool[field];
    if (schema === undefined) continue;
    try { compileJsonSchema(schema); }
    catch (error) { throw new Error(`MCP tool ${JSON.stringify(tool.toolName)} ${field}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

const jsonSchema = z.json();
const envelopeSchema = z.object({
  structuredContent: jsonSchema,
  content: z.array(z.object({ type: z.string() }).catchall(jsonSchema)),
}).strict();


export function boundedMcpValue(value: unknown): Json {
  const json = jsonSchema.parse(value) as Json;
  return json;
}

// Scheduler boundary: validate executor results and manually supplied outputs alike.
export function validateMcpOutput(tool: McpToolSnapshot, value: unknown): Json {
  const envelope = envelopeSchema.parse(value);
  if (tool.outputSchema !== undefined) validateJsonSchema(tool.outputSchema, envelope.structuredContent as Json);
  return envelope;
}
