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
  WorkflowEnquiry,
} from "../../../src/protocol/workflow-executions.ts";
import { parseValue } from "../../../src/workflows/schema.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { useAgentSessions } from "../agent-sessions.tsx";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { initialValue, ValueEditor } from "./workflow-editors.tsx";
import { WorkflowGraph } from "./workflow-graph.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { attemptDuration } from "../presentation/workflow-execution.ts";
import { WorkflowTranscript } from "./workflow-transcript.tsx";
import "./workflows.css";
export default function WorkflowsPane({ sessionId, placement = "right" }: { sessionId: string; placement?: "right" | "bottom" }) {
  const definitions = useWorkflowResource<{ workflows: WorkflowDefinition[] }>(
    "/api/workflows",
  );
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/workflows`;
  const history = useWorkflowResource<WorkflowExecutionList>(base);
  const [workflowId, setWorkflowId] = useState("");
  const [input, setInput] = useState<Json>({});
  const [executionId, setExecutionId] = useState("");
  const [stepId, selectStep] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"Overview" | "Flow">("Overview");
  const [creating, setCreating] = useState(false);
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
  const step = execution?.definition.steps.find((s) => s.id === stepId);
  const record = execution?.steps[stepId];
  const executions = [...(history.data?.executions ?? [])].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  useEffect(() => {
    setWorkflowId("");
    setInput({});
    setExecutionId("");
    selectStep("");
    setMessage("");
    setCreating(false);
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
      if (result.execution) { setExecutionId(result.execution.id); setCreating(false); }
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
                onClick={() => void mutate(base, { workflowId, input })}
              >
                Start workflow
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
            selectStep("");
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
          {view.permissions.map((p) => (
            <fieldset
              key={`${p.subagentId}/${p.callId}`}
              className="flex flex-wrap gap-2 rounded-lg border p-3"
            >
              <legend className="px-1 font-medium">
                Permission ·{" "}
                {execution.definition.steps.find((item) => item.id === p.stepId)
                  ?.name ?? p.stepId}
              </legend>
              <p className="w-full font-mono text-xs">{p.tool}</p>
              {((p.direct ? ["allow", "deny"] : ["allow", "always", "deny"]) as Array<"allow" | "deny" | "always">).map((decision) => (
                <Button
                  size="sm"
                  variant={decision === "deny" ? "destructive" : "outline"}
                  key={decision}
                  disabled={busy}
                  onClick={() =>
                    void mutate(`${base}/${execution.id}/permission`, {
                      subagentId: p.subagentId,
                      callId: p.callId,
                      decision,
                    })
                  }
                >
                  {decision === "always"
                    ? "Always allow on this machine"
                    : decision === "allow"
                      ? "Allow"
                      : "Deny"}
                </Button>
              ))}
            </fieldset>
          ))}
          {view.enquiries.map((q) => (
            <EnquiryForm
              key={`${q.subagentId}/${q.askId}`}
              enquiry={q}
              stepName={
                execution.definition.steps.find((item) => item.id === q.stepId)
                  ?.name ?? q.stepId
              }
              send={(answers) =>
                mutate(`${base}/${execution.id}/enquiry`, {
                  subagentId: q.subagentId,
                  askId: q.askId,
                  answers,
                })
              }
            />
          ))}
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
            selectedStepId={stepId}
            onSelect={id => { selectStep(id); setAttempt(undefined); }}
          />}
          {tab === "Flow" && step && <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => selectStep("")}>← Back to flow</Button>}
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
                  <WorkflowTranscript key={`${execution.id}/${step.id}/${a.number}`} base={`${base}/${execution.id}`} sessionId={sessionId} stepId={step.id} attempt={a.number} legacy={!view.historyComplete} />
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
function EnquiryForm({
  enquiry,
  stepName,
  send,
}: {
  enquiry: WorkflowEnquiry;
  stepName: string;
  send: (answers: string[][]) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<string[][]>(
    enquiry.questions.map(() => []),
  );
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3 rounded-lg border border-status-awaiting/50 bg-status-awaiting/5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void send(answers).finally(() => setBusy(false));
      }}
    >
      <h3 className="font-semibold">Enquiry · {stepName}</h3>
      {enquiry.questions.map((q, i) => (
        <fieldset key={i}>
          <legend className="mb-2">
            {q.header}: {q.question}
          </legend>
          {q.options.map((o) => (
            <label key={o.label} className="mb-2 flex items-start gap-2">
              <input
                className="mt-1 accent-primary"
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`${enquiry.askId}-${i}`}
                checked={answers[i]?.includes(o.label) ?? false}
                onChange={(e) =>
                  setAnswers((old) =>
                    old.map((a, n) =>
                      n !== i
                        ? a
                        : q.multiSelect
                          ? e.target.checked
                            ? [...a, o.label]
                            : a.filter((v) => v !== o.label)
                          : [o.label],
                    ),
                  )
                }
              />
              <span>
                {o.label} — {o.description}
              </span>
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Your answer</span>
            <Input
              value={
                answers[i]
                  ?.filter((a) => !q.options.some((o) => o.label === a))
                  .join("") ?? ""
              }
              onChange={(e) =>
                setAnswers((old) =>
                  old.map((a, n) => (n === i ? [e.target.value] : a)),
                )
              }
            />
          </label>
        </fieldset>
      ))}
      <Button
        type="submit"
        size="sm"
        className="justify-self-start"
        disabled={busy || answers.some((a) => !a.some((v) => v.trim()))}
      >
        Submit answers
      </Button>
    </form>
  );
}
