import { z } from 'zod';
import { validSecretName } from '../protocol/secrets.ts';
import { Decisions } from './decisions.ts';
import type { InputReference, Json, VisualSchema, WorkflowDefinition, WorkflowEdge, WorkflowExecution, WorkflowStep } from '../protocol/workflows.ts';
import { dictionaryKey, dictionaryRecord, declaredOutputSchema, partialSchema, schemaAssignable, schemaAt, unionSchema, validateSchema, valueAt, visualSchemaValidator } from './schema.ts';

const reference = z.discriminatedUnion('source', [
  z.object({ source: z.literal('input'), path: z.array(z.string()) }).strict(),
  z.object({ source: z.literal('step'), stepId: z.string(), path: z.array(z.string()) }).strict(),
]);
const base = {
  id: dictionaryKey.min(1), name: dictionaryKey.min(1), inputSchema: visualSchemaValidator.optional(),
  mapping: z.discriminatedUnion('kind', [z.object({ kind: z.literal('reference'), reference }).strict(), z.object({ kind: z.literal('object'), fields: dictionaryRecord(reference) }).strict()]).optional(),
  permission: z.enum(['ask', 'auto-accept']).optional(), timeoutMs: z.number().int().positive().max(2147483647).optional(),
  secrets: dictionaryRecord(z.string().refine(validSecretName, 'Invalid secret reference')).optional(), position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
};
const condition = z.discriminatedUnion('operator', [
  z.object({ operator: z.literal('truthy'), path: z.array(z.string()) }).strict(),
  z.object({ operator: z.enum(['equals', 'not-equals']), path: z.array(z.string()), value: z.json() }).strict(),
  z.object({ operator: z.enum(['greater-than', 'less-than']), path: z.array(z.string()), value: z.number() }).strict(),
]);
export const workflowDefinitionValidator = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), name: z.string().min(1), backend: z.string().min(1), projectId: z.string().optional(),
  permission: z.enum(['ask', 'auto-accept']).optional(), inputSchema: visualSchemaValidator.refine(schema => schema.type === 'object'),
  steps: z.array(z.discriminatedUnion('kind', [
    z.object({ ...base, kind: z.literal('agent'), instructions: z.string(), model: z.string().min(1), effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), outputSchema: visualSchemaValidator }).strict(),
    z.object({ ...base, kind: z.literal('shell'), command: z.string(), acceptedExitCodes: z.array(z.number().int()).min(1).optional() }).strict(),
    z.object({ ...base, kind: z.literal('typescript'), code: z.string(), outputSchema: visualSchemaValidator }).strict(),
    z.object({ ...base, kind: z.literal('branch'), condition }).strict(),
    z.object({ ...base, kind: z.literal('join') }).strict(),
  ])).min(1),
  edges: z.array(z.object({ id: z.string().min(1), from: z.string(), to: z.string(), outcome: z.enum(['success', 'failure', 'timeout', 'true', 'false']) }).strict()),
}).strict();

export interface WorkflowGraph {
  definition: WorkflowDefinition;
  order: WorkflowStep[];
  incoming: Map<string, WorkflowEdge[]>;
  outgoing: Map<string, WorkflowEdge[]>;
  outputSchemas: Map<string, VisualSchema>;
  inputSchemas: Map<string, VisualSchema>;
}

export function validateDefinition(value: unknown): WorkflowGraph {
  const definition = workflowDefinitionValidator.parse(value) as WorkflowDefinition;
  validateSchema(definition.inputSchema);
  const steps = new Map(definition.steps.map(step => [step.id, step]));
  if (steps.size !== definition.steps.length || new Set(definition.steps.map(step => step.name)).size !== steps.size) throw new Error('Step IDs and names must be unique');
  if (new Set(definition.edges.map(edge => edge.id)).size !== definition.edges.length) throw new Error('Edge IDs must be unique');
  const incoming = new Map(definition.steps.map(step => [step.id, [] as WorkflowEdge[]]));
  const outgoing = new Map(definition.steps.map(step => [step.id, [] as WorkflowEdge[]]));
  const connections = new Set<string>();
  for (const edge of definition.edges) {
    const source = steps.get(edge.from);
    if (!source || !steps.has(edge.to)) throw new Error('Unknown edge endpoint');
    const key = JSON.stringify([edge.from, edge.to, edge.outcome]);
    if (connections.has(key)) throw new Error('Duplicate connection');
    connections.add(key);
    if (source.kind === 'branch' ? !['true', 'false', 'failure', 'timeout'].includes(edge.outcome) : ['true', 'false'].includes(edge.outcome)) throw new Error('Invalid edge outcome');
    incoming.get(edge.to)!.push(edge);
    outgoing.get(edge.from)!.push(edge);
  }
  const order: WorkflowStep[] = [];
  const remaining = new Set(steps.keys());
  while (remaining.size) {
    const ready = [...remaining].filter(id => incoming.get(id)!.every(edge => !remaining.has(edge.from)));
    if (!ready.length) throw new Error('Workflow must be a DAG');
    for (const id of ready) { order.push(steps.get(id)!); remaining.delete(id); }
  }
  const decisions = new Decisions();
  const completed = new Map<string, number>();
  const recovery = new Map<string, number>();
  const selectedEdges = new Map<string, number>();
  const blockedEdges = new Map<string, number>();
  const any = (values: number[]) => values.reduce((left, right) => decisions.or(left, right), 0);
  const ancestors = new Map<string, Set<string>>();
  const outputSchemas = new Map<string, VisualSchema>();
  const inputSchemas = new Map<string, VisualSchema>();
  const graph = { definition, order, incoming, outgoing, outputSchemas, inputSchemas };
  for (const step of order) {
    const edges = incoming.get(step.id)!;
    const blockedHere = any(edges.map(edge => blockedEdges.get(edge.id)!));
    const reach = decisions.and(edges.length ? any(edges.map(edge => selectedEdges.get(edge.id)!)) : 1, decisions.not(blockedHere));
    const recovering = any(edges.map(edge => decisions.and(selectedEdges.get(edge.id)!, edge.outcome === 'failure' || edge.outcome === 'timeout' ? 1 : recovery.get(edge.from)!)));
    recovery.set(step.id, recovering);
    const variable = order.indexOf(step);
    const failure = decisions.outcome(variable, 1);
    const timeout = decisions.outcome(variable, 2);
    const success = decisions.not(decisions.or(failure, timeout));
    completed.set(step.id, decisions.and(reach, success));
    const outcomes = { success, failure, timeout, true: any([decisions.outcome(variable, 0), decisions.outcome(variable, 3)]), false: decisions.outcome(variable, 4) };
    const outgoingEdges = outgoing.get(step.id)!;
    const unhandled = decisions.or(
      decisions.and(failure, outgoingEdges.some(edge => edge.outcome === 'failure') ? recovering : 1),
      decisions.and(timeout, outgoingEdges.some(edge => edge.outcome === 'timeout') ? recovering : 1),
    );
    for (const edge of outgoingEdges) {
      const isRecovery = edge.outcome === 'failure' || edge.outcome === 'timeout';
      selectedEdges.set(edge.id, decisions.and(reach, decisions.and(outcomes[edge.outcome], isRecovery ? decisions.not(recovering) : 1)));
      blockedEdges.set(edge.id, decisions.or(blockedHere, isRecovery ? 0 : decisions.and(reach, unhandled)));
    }
    ancestors.set(step.id, new Set(edges.flatMap(edge => [edge.from, ...ancestors.get(edge.from)!])));
    const referenceSchema = (ref: InputReference) => {
      if (ref.source === 'input') return schemaAt(definition.inputSchema, ref.path);
      const source = steps.get(ref.stepId);
      if (!source || !ancestors.get(step.id)!.has(ref.stepId)) throw new Error('Mapping must reference an earlier step');
      if (!decisions.implies(reach, completed.get(source.id)!)) throw new Error(`Output is not guaranteed: ${source.name}`);
      return schemaAt(outputSchemas.get(source.id)!, ref.path);
    };
    if (step.kind === 'join' && step.mapping) throw new Error('Joins collect selected incoming outputs without mappings');
    let input: VisualSchema;
    if (step.mapping?.kind === 'reference') {
      const field = referenceSchema(step.mapping.reference);
      if (field.optional) throw new Error('A direct input reference must be required or have a default');
      input = field.schema;
    }
    else if (step.mapping?.kind === 'object') input = { type: 'object', fields: Object.fromEntries(Object.entries(step.mapping.fields).map(([name, ref]) => {
      const field = referenceSchema(ref);
      return [name, { schema: field.schema, required: !field.optional }];
    })) };
    else if (!edges.length) input = definition.inputSchema;
    else {
      const sources = [...new Set(edges.map(edge => edge.from))];
      const fields = Object.fromEntries(sources.map(id => {
        const source = steps.get(id)!;
        const connections = edges.filter(edge => edge.from === id);
        const schema = unionSchema(connections.map(edge => edge.outcome === 'failure' || edge.outcome === 'timeout' ? recoverySchema(inputSchemas.get(id)!, outputSchemas.get(id)!) : outputSchemas.get(id)!));
        return [source.name, { schema, required: decisions.implies(reach, any(connections.map(edge => selectedEdges.get(edge.id)!))) }];
      }));
      const collected: VisualSchema = { type: 'object', fields };
      const required = Object.values(fields).filter(field => field.required).length;
      input = step.kind === 'join' || required > 1 ? collected : unionSchema([
        ...Object.values(fields).map(field => field.schema), ...(sources.length > 1 ? [collected] : []),
      ]);
    }
    if (step.inputSchema) {
      validateSchema(step.inputSchema);
      if (!schemaAssignable(input, step.inputSchema)) throw new Error('Input does not match the declared input schema');
    }
    inputSchemas.set(step.id, step.inputSchema ?? input);
    if (step.kind === 'branch') {
      const field = schemaAt(step.inputSchema ?? input, step.condition.path);
      const expected = step.condition.operator === 'truthy' ? 'boolean' : ['greater-than', 'less-than'].includes(step.condition.operator) ? 'number' : undefined;
      if (expected && (field.optional || !schemaAssignable(field.schema, { type: expected }))) throw new Error(`Branch condition requires a required ${expected}`);
    }
    const output = declaredOutputSchema(step) ?? step.inputSchema ?? input;
    validateSchema(output);
    outputSchemas.set(step.id, output);
  }
  return graph;
}

export function recoverySchema(input: VisualSchema, output: VisualSchema): VisualSchema {
  return { type: 'object', fields: {
    input: { schema: input, required: true },
    error: { required: true, schema: { type: 'object', fields: { message: { schema: { type: 'string' }, required: true }, kind: { schema: { type: 'enum', values: ['failure', 'timeout', 'interrupted'] }, required: true } } } },
    partialOutput: { schema: partialSchema(output) },
  } };
}

export function resolveMapping(execution: WorkflowExecution, step: WorkflowStep): Json | undefined {
  const get = (ref: InputReference) => valueAt(ref.source === 'input' ? execution.input : execution.steps[ref.stepId]!.output!, ref.path);
  if (step.mapping?.kind === 'reference') return get(step.mapping.reference);
  if (step.mapping?.kind === 'object') return Object.fromEntries(Object.entries(step.mapping.fields).flatMap(([name, ref]) => {
    const value = get(ref);
    return value === undefined ? [] : [[name, value]];
  }));
  return undefined;
}
