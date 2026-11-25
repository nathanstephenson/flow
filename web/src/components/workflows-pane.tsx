import { useEffect, useState } from "react";
import type { Json, WorkflowDefinition } from "../../../src/protocol/workflows.ts";
import type {
  WorkflowExecutionList,
  WorkflowExecutionView,
} from "../../../src/protocol/workflow-executions.ts";
import { parseValue } from "../../../src/workflows/schema.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { useAgentSessions } from "../agent-sessions.tsx";
import { workflowIssue } from "../presentation/workflows.ts";
import { clearRetainedWorkflowLaunch, retainedWorkflowLaunch } from "../workflow-launch.ts";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { initialValue, ValueEditor } from "./workflow-editors.tsx";
import {
  WorkflowExecutionInspector,
  type WorkflowMobileNavigation,
} from "./workflow-execution-inspector.tsx";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import "./workflows.css";

export type { WorkflowMobileNavigation } from "./workflow-execution-inspector.tsx";

export default function WorkflowsPane({
  sessionId,
  placement = "right",
  mobileNavigation,
}: {
  sessionId: string;
  placement?: "right" | "bottom";
  mobileNavigation?: WorkflowMobileNavigation;
}) {
  const definitions = useWorkflowResource<{ workflows: WorkflowDefinition[] }>("/api/workflows");
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/workflows`;
  const history = useWorkflowResource<WorkflowExecutionList>(base);
  const [retainedLaunch, setRetainedLaunch] = useState(() => retainedWorkflowLaunch(sessionId));
  const [workflowId, setWorkflowId] = useState(retainedLaunch?.workflowId ?? "");
  const [input, setInput] = useState<Json>(retainedLaunch?.input ?? {});
  const [executionId, setExecutionId] = useState("");
  const [message, setMessage] = useState(retainedLaunch?.error ?? "");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(retainedLaunch !== undefined);
  const detail = useWorkflowResource<WorkflowExecutionView>(
    executionId ? `${base}/${executionId}` : undefined,
    1000,
  );
  const { sessions } = useAgentSessions();
  const session = sessions.find((item) => item.id === sessionId);
  const definition = definitions.data?.workflows.find((item) => item.id === workflowId);
  const execution = detail.data?.execution;
  const pendingInput = !!(detail.data?.enquiries.length || detail.data?.permissions.length);
  const executions = [...(history.data?.executions ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  useEffect(() => {
    const retained = retainedWorkflowLaunch(sessionId);
    setRetainedLaunch(retained);
    setWorkflowId(retained?.workflowId ?? "");
    setInput(retained?.input ?? {});
    setExecutionId("");
    setMessage(retained?.error ?? "");
    setCreating(retained !== undefined);
  }, [sessionId]);
  useEffect(() => {
    if (executionId || !executions.length) return;
    const active = executions.find(
      (item) => item.status === "running" || item.status === "recovery-required",
    );
    setExecutionId((active ?? executions[0]!).id);
  }, [executionId, history.data]);
  let invalid = "";
  try {
    if (definition) {
      validateDefinition(definition);
      parseValue(definition.inputSchema, input);
    }
  } catch (error) {
    invalid = workflowIssue(error);
  }
  const mismatch = definition && session && definition.backend !== session.backend;
  const mutate = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const result = await workflowApi<WorkflowExecutionView>(path, "POST", body);
      if (result.execution) {
        setExecutionId(result.execution.id);
        setCreating(false);
        if (path === base) {
          clearRetainedWorkflowLaunch(sessionId);
          setRetainedLaunch(undefined);
        }
      }
      setMessage("Request accepted");
    } catch (error) {
      setMessage(workflowIssue(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflow-panel grid grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-auto p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Workflows</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !history.data || history.data.occupied || session?.status === "ended"}
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? "Close" : "New workflow"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Independent of parent chat. Steps share this Scope.</p>
      {(definitions.error || history.error || detail.error || message) && (
        <p className="text-xs text-muted-foreground" role="status">
          {message || definitions.error || history.error || detail.error}
        </p>
      )}
      {retainedLaunch && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3" role="alert">
          <p className="font-medium">Workflow did not start</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This Agent Session was kept. Review the preserved inputs below and retry here; retrying will not
            create another Agent Session.
          </p>
        </div>
      )}
      {creating && !history.data?.occupied && (
        <section aria-label="New workflow">
          <div className="grid gap-3 pt-2">
            <Select
              value={workflowId}
              onValueChange={(value) => {
                if (value === null) return;
                setWorkflowId(value);
                const definition = definitions.data?.workflows.find((item) => item.id === value);
                setInput(definition ? initialValue(definition.inputSchema) : {});
              }}
            >
              <SelectTrigger className="w-full" aria-label="Workflow">
                <SelectValue>{definition?.name ?? "Select workflow"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Select workflow</SelectItem>
                {definitions.data?.workflows.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {definition && (
              <>
                <ValueEditor schema={definition.inputSchema} value={input} onChange={setInput} />
                {mismatch && (
                  <p role="alert">
                    This workflow requires Backend Adapter {definition.backend}.{" "}
                    <a className="underline" href={`#/new/${encodeURIComponent(definition.backend)}`}>
                      Create a matching Agent Session
                    </a>
                    .
                  </p>
                )}
                {invalid && (
                  <pre
                    className="whitespace-pre-wrap break-words font-mono text-xs text-destructive"
                    role="alert"
                  >
                    {invalid}
                  </pre>
                )}
                <Button
                  size="sm"
                  className="justify-self-start"
                  disabled={
                    busy ||
                    !history.data ||
                    history.data.occupied ||
                    session?.status === "ended" ||
                    !!invalid ||
                    !!mismatch
                  }
                  onClick={() =>
                    void mutate(base, {
                      workflowId,
                      input,
                      ...(retainedLaunch ? { launchId: retainedLaunch.launchId, nameSession: true } : {}),
                    })
                  }
                >
                  {retainedLaunch ? "Retry workflow" : "Start workflow"}
                </Button>
              </>
            )}
          </div>
        </section>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Execution history</span>
        <Select
          items={[
            { value: "", label: "Select execution" },
            ...executions.map((item) => ({
              value: item.id,
              label: `${item.name} · ${item.status.replaceAll("-", " ")} · ${new Date(item.startedAt).toLocaleString()}${item.testStepId ? " · step test" : ""}`,
            })),
          ]}
          disabled={busy}
          value={executionId}
          onValueChange={(value) => {
            if (value !== null) {
              setExecutionId(value);
              mobileNavigation?.onBack();
            }
          }}
        >
          <SelectTrigger className="w-full" aria-label="Execution history">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Select execution</SelectItem>
            {executions.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name} · {item.status.replaceAll("-", " ")} · {new Date(item.startedAt).toLocaleString()}
                {item.testStepId ? " · step test" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {execution && (
        <>
          {["running", "recovery-required"].includes(execution.status) && (
            <>
              <p className="text-xs text-muted-foreground">Cancel stops work; it does not undo changes.</p>
              <Button
                size="sm"
                variant="destructive"
                className="justify-self-start"
                disabled={busy}
                onClick={() => void mutate(`${base}/${executionId}/cancel`)}
              >
                Cancel execution
              </Button>
            </>
          )}
          {execution.status === "recovery-required" && (
            <p>Ask the parent in chat to diagnose and recover this execution.</p>
          )}
          {pendingInput && (
            <section aria-label="Workflow input actions" className="grid gap-2">
              <h4 className="font-medium">Input requested in parent chat</h4>
              <p className="text-xs text-muted-foreground">
                The parent relays one request at a time using the normal composer controls. This pane stays on
                the execution so management actions remain available.
              </p>
              <p className="text-xs text-muted-foreground">
                {session?.status === "dormant" || session?.status === "settled"
                  ? "Revive the parent manually to continue. The request will remain pending here."
                  : session?.status === "running" || session?.status === "awaiting"
                    ? "The request is queued behind the parent’s current turn."
                    : "The parent is preparing the next request."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() =>
                  document.querySelector<HTMLElement>("[data-pane] [data-composer-input]")?.focus()
                }
              >
                Go to parent chat
              </Button>
            </section>
          )}
          {detail.data && (
            <WorkflowExecutionInspector
              key={`${sessionId}/${executionId}`}
              view={detail.data}
              detailBase={`${base}/${executionId}`}
              transcriptBase={`${base}/${executionId}`}
              placement={placement}
              mobileNavigation={mobileNavigation}
            />
          )}
        </>
      )}
    </section>
  );
}
