import { Type } from "typebox";
import { workflowBuilderTools, type WorkflowBuilder } from "../workflow-builder.ts";

export function piWorkflowBuilderTools(builder: WorkflowBuilder) {
  return workflowBuilderTools.map(({ name, label, field, method, description }) => ({
    name, label, description,
    parameters: Type.Object({ [field]: Type.String() }),
    execute: async (_id: string, input: Record<string, string>) => ({
      content: [{ type: "text" as const, text: await builder[method](input[field]!) }], details: {},
    }),
  }));
}
