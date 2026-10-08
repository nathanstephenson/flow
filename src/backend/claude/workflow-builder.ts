import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { workflowBuilderTools, type WorkflowBuilder } from "../workflow-builder.ts";

export const claudeWorkflowBuilderToolNames = workflowBuilderTools.map(({ name }) => `mcp__flow_workflow_builder__${name}`);

export function workflowBuilderServer(builder: WorkflowBuilder) {
  // Only this in-process transport is enabled: no external MCP connections are inherited.
  return { flow_workflow_builder: createSdkMcpServer({ name: "flow_workflow_builder", alwaysLoad: true,
    tools: workflowBuilderTools.map(({ name, field, method, description }) =>
      tool(name, description, { [field]: z.string() }, async input => ({
        content: [{ type: "text", text: await builder[method](input[field]!) }],
      }))),
  }) };
}
