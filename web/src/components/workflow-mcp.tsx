import { useEffect, useRef, useState } from "react";
import type {
  McpToolDiscovery,
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
import type { WorkflowMcpConnections } from "../../../src/protocol/workflow-mcp-authoring.ts";
import { workflowMcpApi } from "./workflow-api.ts";
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
  const query = definition.projectId
    ? `?projectId=${encodeURIComponent(definition.projectId)}`
    : "";
  const connectionsPath = `/api/workflow-mcp${query}`;
  const [selection, setSelection] = useState({
    path: connectionsPath,
    id: step.tool.connectionId,
  });
  const connectionId = selection.path === connectionsPath ? selection.id : "";
  const [connections, setConnections] = useState<{
    path: string;
    data?: WorkflowMcpConnections;
    error?: string;
  }>();
  const [connectionsRefresh, setConnectionsRefresh] = useState(0);
  const connectionsVersion = useRef(0);
  const available =
    connections?.path === connectionsPath ? connections : undefined;
  useEffect(() => {
    const controller = new AbortController();
    const version = ++connectionsVersion.current;
    setConnections(undefined);
    setSelection((current) =>
      current.path === connectionsPath
        ? current
        : { path: connectionsPath, id: "" },
    );
    void workflowMcpApi<WorkflowMcpConnections>(
      connectionsPath,
      controller.signal,
    )
      .then((data) => {
        if (version === connectionsVersion.current && !controller.signal.aborted)
          setConnections({ path: connectionsPath, data });
      })
      .catch((error) => {
        if (version === connectionsVersion.current && !controller.signal.aborted)
          setConnections({ path: connectionsPath, error: String(error) });
      });
    return () => {
      connectionsVersion.current++;
      controller.abort();
    };
  }, [connectionsPath, connectionsRefresh]);
  const selectedConnection = available?.data?.connections.find(
    (connection) => connection.id === connectionId,
  );
  const discoveryPath = selectedConnection
    ? `/api/workflow-mcp/${encodeURIComponent(connectionId)}${query}`
    : undefined;
  const [discovery, setDiscovery] = useState<{
    path: string;
    data?: McpToolDiscovery;
    error?: string;
  }>();
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);
  const consumedDiscoveryRefresh = useRef(0);
  const discoveryVersion = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++discoveryVersion.current;
    const refresh = discoveryRefresh !== consumedDiscoveryRefresh.current;
    consumedDiscoveryRefresh.current = discoveryRefresh;
    setDiscovery(undefined);
    if (discoveryPath) {
      void workflowMcpApi<McpToolDiscovery>(
        refresh ? `${discoveryPath}${query ? "&" : "?"}refresh=1` : discoveryPath,
        controller.signal,
      )
        .then((data) => {
          if (version === discoveryVersion.current && !controller.signal.aborted)
            setDiscovery({ path: discoveryPath, data });
        })
        .catch((error) => {
          if (version === discoveryVersion.current && !controller.signal.aborted)
            setDiscovery({ path: discoveryPath, error: String(error) });
        });
    }
    return () => {
      discoveryVersion.current++;
      controller.abort();
    };
  }, [discoveryPath, discoveryRefresh]);
  const result = discovery?.path === discoveryPath ? discovery : undefined;
  const busy = !!discoveryPath && !result;
  const tools = result?.data?.tools ?? [];
  const toolErrors = result?.data?.errors ?? [];
  const compatible = tools.length;
  const incompatible = toolErrors.length;
  const discoverySummary = !result?.data
    ? ""
    : compatible
      ? `${compatible} compatible ${compatible === 1 ? "tool" : "tools"} available.${incompatible ? ` ${incompatible} incompatible ${incompatible === 1 ? "tool cannot" : "tools cannot"} be selected.` : ""}`
      : incompatible
        ? `No compatible tools. All ${incompatible} discovered ${incompatible === 1 ? "tool is" : "tools are"} incompatible.`
        : "This server reported no tools.";
  const [phase, setPhase] = useState<"mapping" | "repeatMapping">("mapping");
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
          Discover tools in the Workflow Definition’s Scope without opening an
          Agent Session. Execution and step testing require this connection to be
          enabled for the owning Agent Session. Credentials stay in MCP Settings.
        </p>
        <p className="break-all text-xs text-muted-foreground">
          Scope: {available?.data?.scope ?? (available?.error ? "Unavailable" : "Loading…")}
        </p>
        <p className="text-xs text-muted-foreground">
          Metadata discovery can start a local stdio server under the usual
          filesystem-isolation policy. When isolation is disabled, it has the
          host user’s filesystem access.
        </p>
        <Select
          value={connectionId}
          disabled={!available?.data?.connections.length}
          onValueChange={(id) =>
            setSelection({ path: connectionsPath, id: id ?? "" })
          }
        >
          <SelectTrigger aria-label="MCP server">
            <SelectValue>
              {selectedConnection?.name ?? "Select configured MCP server"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {available?.data?.connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.name} · {connection.transport}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !discoveryPath}
          onClick={() => setDiscoveryRefresh((current) => current + 1)}
        >
          {busy
            ? "Discovering…"
            : result?.error
              ? "Retry discovery"
              : "Refresh tools"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!available}
          onClick={() => setConnectionsRefresh((current) => current + 1)}
        >
          {!available
            ? "Loading servers…"
            : available.error
              ? "Retry servers"
              : "Refresh servers"}
        </Button>
        {available?.data?.connections.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No MCP servers configured. Add a connection in MCP Settings.
          </p>
        )}
        {discoverySummary && (
          <p
            className={`text-xs ${toolErrors.length ? "text-destructive" : "text-muted-foreground"}`}
            role="status"
          >
            {discoverySummary}
          </p>
        )}
        {toolErrors.length > 0 && (
          <section aria-label="Incompatible MCP tools" className="grid gap-2">
            {toolErrors.map((error, index) => (
              <details
                key={`${error.toolName}/${index}`}
                className="min-w-0 rounded-lg border bg-card p-3 text-xs"
              >
                <summary className="cursor-pointer break-words rounded-sm font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {error.toolName} · incompatible
                </summary>
                <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                  {error.message}
                </p>
              </details>
            ))}
          </section>
        )}
        <Select
          value={JSON.stringify(step.tool)}
          disabled={busy || !tools.length}
          onValueChange={(snapshot) => {
            const tool = tools.find((tool) => JSON.stringify(tool) === snapshot);
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
              <SelectItem key={tool.toolName} value={JSON.stringify(tool)}>
                {tool.toolName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Tool identity and original schemas are pinned. Changed servers or
          schemas require explicit reselection, not automatic retargeting.
        </p>
        {result?.error && (
          <p className="text-xs text-destructive" role="alert">
            {result.error}
          </p>
        )}
        {available?.error && (
          <p className="text-xs text-destructive" role="alert">
            {available.error}
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
