import { useEffect, useRef, useState } from "react";
import type {
  McpToolSnapshot,
  WorkflowDefinition,
  WorkflowStep,
} from "../../../src/protocol/workflows.ts";
import { validateJsonSchema } from "../../../src/workflows/json-schema.ts";
import { analyzeLoops } from "../../../src/workflows/loops.ts";
import { mappingChoices } from "../presentation/workflows.ts";
import {
  initialTemplate,
  templateValue,
} from "../presentation/workflow-json-schema.ts";
import { useAgentSessions } from "../agent-sessions.tsx";
import { useWorkflowResource, workflowApi } from "./workflow-api.ts";
import { JsonSchemaEditor } from "./workflow-json-schema.tsx";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select.tsx";

export function McpStepEditor({
  definition,
  step,
  onChange,
}: {
  definition: WorkflowDefinition;
  step: Extract<WorkflowStep, { kind: "mcp" }>;
  onChange: (step: WorkflowStep) => void;
}) {
  const { sessions } = useAgentSessions();
  const [sessionId, setSessionId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [tools, setTools] = useState<McpToolSnapshot[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const discoveryVersion = useRef(0);
  useEffect(() => () => { discoveryVersion.current++; }, []);
  const resetDiscovery = () => {
    discoveryVersion.current++;
    setTools([]);
    setMessage("");
    setBusy(false);
  };
  const [phase, setPhase] = useState<"mapping" | "repeatMapping">("mapping");
  const connections = useWorkflowResource<{
    connections: { id: string; name: string; transport: string }[];
  }>(sessionId ? `/api/sessions/${sessionId}/workflow-mcp` : undefined);
  let loop = false;
  try {
    loop = analyzeLoops(definition).loops.some(
      (loop) => loop.headerId === step.id,
    );
  } catch {
    /* Invalid graphs remain editable. */
  }
  const mappingPhase = loop ? phase : "mapping";
  const mapping = step[mappingPhase];
  const template =
    mapping?.kind === "template"
      ? mapping.template
      : initialTemplate(step.tool.inputSchema);
  let choices: ReturnType<typeof mappingChoices> = [];
  let validation = "";
  try {
    choices = mappingChoices(definition, step.id, "object", mappingPhase);
    const value = templateValue(template);
    if (value !== undefined) validateJsonSchema(step.tool.inputSchema, value);
    else
      validation = "References are resolved and validated before every call.";
  } catch (error) {
    validation = error instanceof Error ? error.message : String(error);
  }
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">
          MCP tool · no model tokens
        </legend>
        <p className="text-xs text-muted-foreground">
          Uses only connections enabled for the executing Agent Session.
          Credentials stay in MCP Settings. No Shell or TypeScript runtime is
          used.
        </p>
        <Select
          value={sessionId}
          onValueChange={(id) => {
            setSessionId(id ?? "");
            setConnectionId("");
            resetDiscovery();
          }}
        >
          <SelectTrigger aria-label="MCP discovery Agent Session">
            <SelectValue>
              {sessionId || "Select Agent Session for discovery"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sessions.map((session) => (
              <SelectItem key={session.id} value={session.id}>
                {session.id} · {session.backend}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={connectionId}
          onValueChange={(id) => {
            setConnectionId(id ?? "");
            resetDiscovery();
          }}
        >
          <SelectTrigger aria-label="MCP server">
            <SelectValue>
              {connections.data?.connections.find(
                (connection) => connection.id === connectionId,
              )?.name ?? "Select enabled MCP server"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {connections.data?.connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.name} · {connection.transport}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !connectionId}
          onClick={async () => {
            const version = ++discoveryVersion.current;
            setBusy(true);
            setMessage("");
            try {
              const result = await workflowApi<{ tools: McpToolSnapshot[] }>(
                `/api/sessions/${sessionId}/workflow-mcp/${connectionId}`,
              );
              if (version !== discoveryVersion.current) return;
              setTools(result.tools);
              if (!result.tools.length) setMessage("No tools discovered.");
            } catch (error) {
              if (version === discoveryVersion.current) setMessage(String(error));
            } finally {
              if (version === discoveryVersion.current) setBusy(false);
            }
          }}
        >
          Discover tools
        </Button>
        <Select
          value={step.tool.toolName}
          onValueChange={(name) => {
            const tool = tools.find((tool) => tool.toolName === name);
            if (tool)
              onChange({
                ...step,
                tool,
                mapping: {
                  kind: "template",
                  template: initialTemplate(tool.inputSchema),
                },
              });
          }}
        >
          <SelectTrigger aria-label="MCP tool">
            <SelectValue>
              {step.tool.toolName === "unselected"
                ? "Select tool"
                : `${step.tool.connectionName} / ${step.tool.toolName}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tools.map((tool) => (
              <SelectItem key={tool.toolName} value={tool.toolName}>
                {tool.toolName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Tool identity and original schemas are pinned. Changed servers or
          schemas require explicit reselection, not automatic retargeting.
        </p>
        {(message || connections.error) && (
          <p className="text-xs text-destructive" role="alert">
            {message || connections.error}
          </p>
        )}
      </fieldset>
      {loop && (
        <Select
          value={phase}
          onValueChange={(phase) => phase && setPhase(phase)}
        >
          <SelectTrigger aria-label="MCP argument phase">
            <SelectValue>
              {phase === "mapping" ? "First entry" : "Repeat"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mapping">First entry</SelectItem>
            <SelectItem value="repeatMapping">Repeat</SelectItem>
          </SelectContent>
        </Select>
      )}
      <JsonSchemaEditor
        key={`${step.id}/${mappingPhase}/${step.tool.toolName}`}
        schema={step.tool.inputSchema}
        template={template}
        choices={choices}
        onChange={(template) =>
          onChange({ ...step, [mappingPhase]: { kind: "template", template } })
        }
      />
      {validation && (
        <p className="text-xs text-muted-foreground" role="status">
          {validation}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Timeout defaults to 60 seconds. Ask mode requires permission for every
        call, including tests. Cancellation is not rollback: interrupted or
        timed-out writes may already have happened. Inspect the remote state
        before Retry. Calls are never replayed automatically.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary>Stable output envelope</summary>
        <pre className="whitespace-pre-wrap">
          {"{ structuredContent: JSON | null, content: MCPContentBlock[] }"}
        </pre>
        <p>
          Content blocks are preserved without text parsing or resource
          downloads. Serialized results over 100,000 bytes fail without
          truncation.
        </p>
      </details>
    </div>
  );
}
