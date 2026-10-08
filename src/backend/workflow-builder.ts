/** Host-owned capabilities for a restricted Workflow Definition authoring agent.
 * Paths and content are interpreted/validated by the host, never by a backend filesystem tool.
 */
export interface WorkflowBuilder {
  instructions: string;
  read(path: string): Promise<string>;
  list(path: string): Promise<string>;
  write(content: string): Promise<string>;
}

export const workflowBuilderTools = [
  { name: "workflow_builder_read", label: "Read workflow reference", field: "path", method: "read",
    description: "Read a reference at a host-approved path. This is not an arbitrary filesystem reader." },
  { name: "workflow_builder_list", label: "List workflow references", field: "path", method: "list",
    description: "List references at a host-approved path. This is not an arbitrary directory listing." },
  { name: "workflow_builder_write", label: "Save workflow definition", field: "content", method: "write",
    description: "Validate and save Workflow Definition content through the host. The host chooses the destination; no file path is accepted." },
] as const;
