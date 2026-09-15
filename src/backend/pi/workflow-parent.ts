import { Type } from 'typebox';
import { z } from 'zod';
import { workflowInspectInput, workflowRecoverInput, inspectDescription, recoverDescription, type WorkflowParent } from '../workflow-tools.ts';
export function workflowParentTools(parent?: WorkflowParent) {
  if (!parent) return [];
  return [
    { name: 'workflow_inspect', label: 'Inspect workflow', description: inspectDescription,
      parameters: Type.Unsafe<z.input<typeof workflowInspectInput>>(z.toJSONSchema(workflowInspectInput)),
      execute: async (_id: string, input: z.input<typeof workflowInspectInput>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await parent.inspect(input)) }], details: {} }) },
    { name: 'workflow_recover', label: 'Recover workflow', description: recoverDescription,
      parameters: Type.Unsafe<z.input<typeof workflowRecoverInput>>(z.toJSONSchema(workflowRecoverInput)),
      execute: async (_id: string, input: z.input<typeof workflowRecoverInput>, signal?: AbortSignal) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await parent.recover(input, signal)) }], details: {} }) },
  ];
}
