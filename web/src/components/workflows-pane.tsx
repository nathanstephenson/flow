import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import {
  limitedLoops,
  loopProgress,
} from "../presentation/workflow-loops.ts";
import {
  workflowIssue,
} from "../presentation/workflows.ts";
import type {
  Json,
  WorkflowDefinition,
} from "../../../src/protocol/workflows.ts";
import type {
  WorkflowExecutionList,
  WorkflowExecutionView,
} from "../../../src/protocol/workflow-executions.ts";
import { parseValue } from "../../../src/workflows/schema.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { useAgentSessions } from "../agent-sessions.tsx";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { initialValue, ValueEditor } from "./workflow-editors.tsx";
import { WorkflowGraph } from "./workflow-graph.tsx";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { attemptDuration } from "../presentation/workflow-execution.ts";
import { clearRetainedWorkflowLaunch, retainedWorkflowLaunch } from "../workflow-launch.ts";
import { WorkflowTranscript } from "./workflow-transcript.tsx";
import "./workflows.css";
export type WorkflowMobileNavigation = {
  stepId: string;
  onSelect: (stepId: string) => void;
  onBack: () => void;
};

export default function WorkflowsPane({
  sessionId,
  placement = "right",
  mobileNavigation,
}: {
  sessionId: string;
  placement?: "right" | "bottom";
  mobileNavigation?: WorkflowMobileNavigation;
}) {
  const definitions = useWorkflowResource<{ workflows: WorkflowDefinition[] }>(
    "/api/workflows",
  );
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/workflows`;
  const history = useWorkflowResource<WorkflowExecutionList>(base);
  // Keep the cloned launch in component state: polling this pane must not clone a potentially
  // large validated input on every render.
  const [retainedLaunch, setRetainedLaunch] = useState(() => retainedWorkflowLaunch(sessionId));
  const [workflowId, setWorkflowId] = useState(retainedLaunch?.workflowId ?? "");
  const [input, setInput] = useState<Json>(retainedLaunch?.input ?? {});
  const [executionId, setExecutionId] = useState("");
  const [stepId, selectStep] = useState("");
  const shownStepId = mobileNavigation?.stepId ?? stepId;
  const showStep = (id: string) => {
    selectStep(id);
    mobileNavigation?.onSelect(id);
  };
  const showFlow = () => {
    selectStep("");
    mobileNavigation?.onBack();
  };
  const [message, setMessage] = useState(retainedLaunch?.error ?? "");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"Overview" | "Flow">("Overview");
  const [creating, setCreating] = useState(retainedLaunch !== undefined);
  const [attempt, setAttempt] = useState<number>();
  const detail = useWorkflowResource<WorkflowExecutionView>(
    executionId ? `${base}/${executionId}` : undefined,
    1000,
  );
  const { sessions } = useAgentSessions();
  const session = sessions.find((s) => s.id === sessionId);
  const definition = definitions.data?.workflows.find(
    (d) => d.id === workflowId,
  );
  const view = detail.data;
  const execution = view?.execution;
  const step = execution?.definition.steps.find((s) => s.id === shownStepId);
  const record = execution?.steps[shownStepId];
  const executions = [...(history.data?.executions ?? [])].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  useEffect(() => {
    const retained = retainedWorkflowLaunch(sessionId);
    setRetainedLaunch(retained);
    setWorkflowId(retained?.workflowId ?? "");
    setInput(retained?.input ?? {});
    setExecutionId("");
    selectStep("");
    setMessage(retained?.error ?? "");
    setCreating(retained !== undefined);
    setTab("Overview");
    setAttempt(undefined);
  }, [sessionId]);
  useEffect(() => {
    if (executionId || !executions.length) return;
    const active = executions.find(
      (item) =>
        item.status === "running" || item.status === "recovery-required",
    );
    setExecutionId((active ?? executions[0]!).id);
  }, [executionId, history.data]);
  let invalid = "";
  try {
    if (definition) {
      validateDefinition(definition);
      parseValue(definition.inputSchema, input);
    }
  } catch (e) {
    invalid = workflowIssue(e);
  }
  const mismatch =
    definition && session && definition.backend !== session.backend;
  const mutate = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const result = await workflowApi<WorkflowExecutionView>(
        path,
        "POST",
        body,
      );
      if (result.execution) {
        setExecutionId(result.execution.id);
        setCreating(false);
        if (path === base) {
          clearRetainedWorkflowLaunch(sessionId);
          setRetainedLaunch(undefined);
        }
      }
      setMessage("Request accepted");
    } catch (e) {
      setMessage(workflowIssue(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflow-panel grid content-start gap-3 overflow-auto p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Workflows</h2>
        <Button size="sm" variant="outline" disabled={busy || !history.data || history.data.occupied || session?.status === "ended"} onClick={() => setCreating(value => !value)}>{creating ? "Close" : "New workflow"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Independent of parent chat. Steps share this Scope.
      </p>
      {(definitions.error || history.error || detail.error || message) && (
        <p className="text-xs text-muted-foreground" role="status">
          {definitions.error || history.error || detail.error || message}
        </p>
      )}
      {retainedLaunch && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3" role="alert">
          <p className="font-medium">Workflow did not start</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This Agent Session was kept. Review the preserved inputs below and retry here; retrying
            will not create another Agent Session.
          </p>
        </div>
      )}
      {creating && !history.data?.occupied && <section aria-label="New workflow">
        <div className="grid gap-3 pt-2">
          <Select
            value={workflowId}
            onValueChange={(value) => {
              if (value === null) return;
              setWorkflowId(value);
              const d = definitions.data?.workflows.find((d) => d.id === value);
              setInput(d ? initialValue(d.inputSchema) : {});
            }}
          >
            <SelectTrigger className="w-full" aria-label="Workflow">
              <SelectValue>{definition?.name ?? "Select workflow"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Select workflow</SelectItem>
              {definitions.data?.workflows.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {definition && (
            <>
              <ValueEditor
                schema={definition.inputSchema}
                value={input}
                onChange={setInput}
              />
              {mismatch && (
                <p role="alert">
                  This workflow requires Backend Adapter {definition.backend}.{" "}
                  <a
                    className="underline"
                    href={`#/new/${encodeURIComponent(definition.backend)}`}
                  >
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
                onClick={() => void mutate(base, { workflowId, input, ...(retainedLaunch ? { launchId: retainedLaunch.launchId, nameSession: true } : {}) })}
              >
                {retainedLaunch ? "Retry workflow" : "Start workflow"}
              </Button>
            </>
          )}
          {history.data?.occupied && (
            <p className="text-xs text-muted-foreground">
              Recover or cancel the current execution before starting another.
            </p>
          )}
        </div>
      </section>}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Execution history</span>
        <Select
          items={[
            { value: "", label: "Select execution" },
            ...executions.map((e) => ({
              value: e.id,
              label: `${e.name} · ${e.status.replaceAll("-", " ")} · ${new Date(e.startedAt).toLocaleString()}${e.testStepId ? " · step test" : ""}`,
            })),
          ]}
          disabled={busy}
          value={executionId}
          onValueChange={(value) => {
            if (value === null) return;
            setExecutionId(value);
            if (mobileNavigation?.stepId) showFlow();
            else selectStep("");
            setAttempt(undefined);
          }}
        >
          <SelectTrigger className="w-full" aria-label="Execution history">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Select execution</SelectItem>
            {executions.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name} · {e.status.replaceAll("-", " ")} ·{" "}
                {new Date(e.startedAt).toLocaleString()}
                {e.testStepId ? " · step test" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {execution && (
        <>
          <h3 className="font-semibold">
            {execution.definition.name} ·{" "}
            {view.enquiries.length || view.permissions.length
              ? "awaiting input"
              : execution.status.replaceAll("-", " ")}
          </h3>
          {["running", "recovery-required"].includes(execution.status) && (
            <>
              <p className="text-xs text-muted-foreground">
                Cancel stops work; it does not undo changes.
              </p>
              <Button
                size="sm"
                variant="destructive"
                className="justify-self-start"
                disabled={busy}
                onClick={() => void mutate(`${base}/${execution.id}/cancel`)}
              >
                Cancel execution
              </Button>
            </>
          )}
          {execution.status === "recovery-required" && <div className="rounded-lg border border-status-awaiting/50 bg-status-awaiting/5 p-3">
            <p>Recovery required. Ask the parent in chat to diagnose and recover this execution.</p>
            {limitedLoops(execution).map(([id, loop]) => <p key={id}>{execution.definition.steps.find(step => step.id === id)?.name}: {loopProgress(loop, execution.definition.loopSettings?.[id]?.maxTries ?? 3)}</p>)}
          </div>}
          {view.enquiries.length || view.permissions.length ? (
            <section className="rounded-lg border border-status-awaiting/50 bg-status-awaiting/5 p-3" aria-label="Pending workflow input">
              <h4 className="font-medium">Input requested in parent chat</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                The parent relays one request at a time using the normal composer controls. This pane stays on the execution so management actions remain available.
              </p>
              {[...view.enquiries.map(item => ({ key: `${item.subagentId}/${item.askId}`, stepId: item.stepId, label: "Question" })), ...view.permissions.map(item => ({ key: `${item.subagentId}/${item.callId}`, stepId: item.stepId, label: `Permission · ${item.tool}` }))].map(item => (
                <p key={item.key} className="mt-2 text-xs">
                  <span className="font-medium">{execution.definition.steps.find(step => step.id === item.stepId)?.name ?? item.stepId}</span>
                  <span className="text-muted-foreground"> · {item.label} · pending</span>
                </p>
              ))}
              <p className="mt-2 text-xs text-muted-foreground">
                {session?.status === "dormant" || session?.status === "settled"
                  ? "Revive the parent manually to continue. The request will remain pending here."
                  : session?.status === "running" || session?.status === "awaiting"
                    ? "The request is queued behind the parent’s current turn."
                    : "The parent is preparing the next request."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => document.querySelector<HTMLElement>("[data-pane] [data-composer-input]")?.focus()}
              >
                Go to parent chat
              </Button>
            </section>
          ) : null}
          <div role="tablist" aria-label="Workflow execution view" className="flex gap-1 border-b pb-2">
            {(["Overview", "Flow"] as const).map(name => <Button key={name} role="tab" aria-selected={tab === name} variant={tab === name ? "secondary" : "ghost"} size="sm" onClick={() => setTab(name)}>{name}</Button>)}
          </div>
          {tab === "Overview" && <section role="tabpanel" aria-label="Overview" className="grid min-w-0 gap-3">
            <p className="text-xs text-muted-foreground">Original launch snapshot · read-only. Later workflow edits do not change this execution.</p>
            <p>{execution.definition.steps.length} steps · {execution.definition.backend} · {new Date(execution.startedAt).toLocaleString()}</p>
            <h3 className="font-semibold">Original inputs</h3>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(execution.input, null, 2)}</pre>
            <details><summary className="cursor-pointer font-medium">Original workflow</summary><pre className="whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(execution.definition, null, 2)}</pre></details>
            {Object.entries(execution.steps).filter(([, record]) => record.attempts.at(-1)?.error).map(([id, record]) => <p key={id} className="text-destructive">{execution.definition.steps.find(step => step.id === id)?.name}: {record.attempts.at(-1)?.error?.message}</p>)}
          </section>}
          {tab === "Flow" && !step && <WorkflowGraph
            key={`${execution.id}/${placement}`}
            definition={execution.definition}
            execution={execution}
            orientation={placement === "bottom" ? "horizontal" : "vertical"}
            awaitingSteps={[...view.enquiries, ...view.permissions].map(item => item.stepId)}
            selectedStepId={shownStepId}
            onSelect={id => { showStep(id); setAttempt(undefined); }}
          />}
          {tab === "Flow" && step && (
            <Button size="sm" variant="ghost" className="min-h-10 justify-self-start" onClick={showFlow}>
              <ChevronLeft aria-hidden data-icon="inline-start" />
              Back to flow
            </Button>
          )}
          {tab === "Flow" && step && record && (
            <div className="grid gap-2">
              <h3 className="font-semibold">
                {step.name} · {record.status}
              </h3>
              {step.kind === "agent" && (
                <p>
                  Model: {step.model} · Effort: {step.effort}
                </p>
              )}
              <p>
                Spend:{" "}
                {view.stepSpend[step.id]
                  ? `$${view.stepSpend[step.id]!.costUSD.toFixed(4)} · ${view.stepSpend[step.id]!.tokens.toLocaleString()} tokens`
                  : "Unknown"}
              </p>
              <label className="grid gap-1"><span className="font-medium">Attempt</span><Select value={attempt ?? record.attempts.at(-1)?.number ?? 1} onValueChange={value => value !== null && setAttempt(value)}><SelectTrigger aria-label="Attempt"><SelectValue /></SelectTrigger><SelectContent>{record.attempts.map(a => <SelectItem key={a.number} value={a.number}>Attempt {a.number} · {a.action}{a.error ? " · failed" : ""}</SelectItem>)}</SelectContent></Select></label>
              {record.attempts.filter(a => a.number === (attempt ?? record.attempts.at(-1)?.number)).map((a) => (
                <details key={a.number} open>
                  <summary className="cursor-pointer font-medium">
                    Attempt {a.number} · {a.action} ·{" "}
                    {attemptDuration(a.startedAt, a.finishedAt)}
                  </summary>
                  {a.loops?.map((loop) => (
                    <p
                      key={loop.headerId}
                      className="text-xs text-muted-foreground"
                    >
                      Loop ·{" "}
                      {execution.definition.steps.find(
                        (step) => step.id === loop.headerId,
                      )?.name ?? loop.headerId}{" "}
                      · Try {loop.try} · Activation {loop.activation}
                    </p>
                  ))}
                  <h4 className="mt-2 text-xs font-medium">Input</h4>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {JSON.stringify(a.input, null, 2)}
                  </pre>
                  <h4 className="mt-2 text-xs font-medium">Output</h4>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {JSON.stringify(a.output ?? a.partialOutput, null, 2)}
                  </pre>
                  <WorkflowTranscript key={`${execution.id}/${step.id}/${a.number}`} base={`${base}/${execution.id}`} sessionId={sessionId} stepId={step.id} attempt={a.number} legacy={!view.historyComplete} completed={a.finishedAt !== undefined} />
                  {a.error && (
                    <p role="alert">
                      {a.error.kind}: {a.error.message}
                    </p>
                  )}
                </details>
              ))}
            </div>
          )}
          {tab === "Overview" && execution.result !== undefined && (
            <>
              <h3 className="font-semibold">Result</h3>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {JSON.stringify(execution.result, null, 2)}
              </pre>
            </>
          )}
        </>
      )}
    </section>
  );
}
