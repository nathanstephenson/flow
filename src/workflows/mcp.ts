import { z } from 'zod';
import type { Json, McpToolSnapshot } from '../protocol/workflows.ts';
import { validateJsonSchema } from './json-schema.ts';


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
