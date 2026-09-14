import { useEffect, useState } from "react";
import {
  recoveryCandidates,
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
  RecoverWorkflow,
} from "../../../src/protocol/workflow-executions.ts";
import { parseValue } from "../../../src/workflows/schema.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { useAgentSessions } from "../agent-sessions.tsx";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { initialValue, ValueEditor } from "./workflow-editors.tsx";
import { WorkflowGraph } from "./workflow-graph.tsx";
import "./workflows.css";
export default function WorkflowsPane({ sessionId }: { sessionId: string }) {
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
  }, [sessionId]);
  useEffect(() => {
    if (executionId || !executions.length) return;
    const active = executions.find(
      (item) =>
        item.status === "running" || item.status === "recovery-required",
    );
    setExecutionId((active ?? executions[0]!).id);
  }, [executionId, history.data]);
  useEffect(() => {
    if (!execution || step) return;
    const pending = view.enquiries[0]?.stepId ?? view.permissions[0]?.stepId;
    selectStep(
      pending ??
        execution.definition.steps.find(
          (item) => execution.steps[item.id]?.status === "running",
        )?.id ??
        execution.definition.steps[0]?.id ??
        "",
    );
  }, [execution, step, view]);
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
      if (result.execution) setExecutionId(result.execution.id);
      setMessage("Request accepted");
    } catch (e) {
      setMessage(workflowIssue(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflows workflow-panel overflow-auto p-3 grid content-start gap-3">
      <h2>Workflows</h2>
      <p className="text-xs text-muted-foreground">
        Independent of parent chat. Steps share this Scope.
      </p>
      <p role="status">
        {definitions.error || history.error || detail.error || message}
      </p>
      <details open={!execution && !history.data?.occupied}>
        <summary>Start a workflow</summary>
        <div className="grid gap-3 pt-2">
          <select
            aria-label="Workflow"
            value={workflowId}
            onChange={(e) => {
              setWorkflowId(e.target.value);
              const d = definitions.data?.workflows.find(
                (d) => d.id === e.target.value,
              );
              setInput(d ? initialValue(d.inputSchema) : {});
            }}
          >
            <option value="">Select workflow</option>
            {definitions.data?.workflows.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
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
              {invalid && <pre role="alert">{invalid}</pre>}
              <button
                disabled={
                  busy ||
                  !history.data ||
                  history.data.occupied ||
                  !!invalid ||
                  !!mismatch
                }
                onClick={() => void mutate(base, { workflowId, input })}
              >
                Start workflow
              </button>
            </>
          )}
          {history.data?.occupied && (
            <p className="text-xs text-muted-foreground">
              Recover or cancel the current execution before starting another.
            </p>
          )}
        </div>
      </details>
      <label>
        Execution history
        <select
          disabled={busy}
          value={executionId}
          onChange={(e) => {
            setExecutionId(e.target.value);
            selectStep("");
          }}
        >
          <option value="">Select execution</option>
          {executions.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {e.status.replaceAll("-", " ")} ·{" "}
              {new Date(e.startedAt).toLocaleString()}
              {e.testStepId ? " · step test" : ""}
            </option>
          ))}
        </select>
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
              <button
                disabled={busy}
                onClick={() => void mutate(`${base}/${execution.id}/cancel`)}
              >
                Cancel execution
              </button>
            </>
          )}
          {view.permissions.map((p) => (
            <fieldset
              key={`${p.subagentId}/${p.callId}`}
              className="border p-2"
            >
              <legend>
                Permission ·{" "}
                {execution.definition.steps.find((item) => item.id === p.stepId)
                  ?.name ?? p.stepId}
              </legend>
              <p>{p.tool}</p>
              {(["allow", "always", "deny"] as const).map((decision) => (
                <button
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
                    : decision}
                </button>
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
          <WorkflowGraph
            definition={execution.definition}
            execution={execution}
            awaitingSteps={[...view.enquiries, ...view.permissions].map(
              (item) => item.stepId,
            )}
            selectedStepId={stepId}
            onSelect={selectStep}
          />
          <label>
            Step details
            <select
              value={stepId}
              onChange={(event) => selectStep(event.target.value)}
            >
              {execution.definition.steps.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ·{" "}
                  {execution.steps[item.id]?.status.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          {step && record && (
            <div className="grid gap-2">
              <h3>
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
              {record.attempts.map((a) => (
                <details key={a.number} open>
                  <summary>
                    Attempt {a.number} · {a.action} ·{" "}
                    {a.finishedAt
                      ? `${a.finishedAt - a.startedAt} ms`
                      : "In progress"}
                  </summary>
                  <h4>Input</h4>
                  <pre>{JSON.stringify(a.input, null, 2)}</pre>
                  <h4>Output</h4>
                  <pre>
                    {JSON.stringify(a.output ?? a.partialOutput, null, 2)}
                  </pre>
                  {a.error && (
                    <p role="alert">
                      {a.error.kind}: {a.error.message}
                    </p>
                  )}
                </details>
              ))}
              <details>
                <summary>Subagent activity</summary>
                {view.activity
                  .filter((a) => a.stepId === step.id)
                  .map((a) => (
                    <pre key={a.sequence}>
                      {JSON.stringify(a.event, null, 2)}
                    </pre>
                  ))}
              </details>
              {execution.status === "recovery-required" &&
                recoveryCandidates(execution).includes(step.id) && (
                  <Recovery
                    key={`${execution.id}/${step.id}`}
                    definition={execution.definition}
                    stepId={step.id}
                    busy={busy}
                    send={(body) =>
                      mutate(`${base}/${execution.id}/recover`, body)
                    }
                  />
                )}
            </div>
          )}
          {execution.status === "recovery-required" &&
            recoveryCandidates(execution).length === 0 && (
              <>
                <p>Earlier operations may already have made changes.</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate(`${base}/${execution.id}/recover`, {
                      kind: "continue",
                    })
                  }
                >
                  Continue
                </button>
              </>
            )}
          {execution.result !== undefined && (
            <>
              <h3>Result</h3>
              <pre>{JSON.stringify(execution.result, null, 2)}</pre>
            </>
          )}
        </>
      )}
    </section>
  );
}
function Recovery({
  definition,
  stepId,
  busy,
  send,
}: {
  definition: WorkflowDefinition;
  stepId: string;
  busy: boolean;
  send: (r: RecoverWorkflow) => Promise<void>;
}) {
  const schema = validateDefinition(definition).outputSchemas.get(stepId)!;
  const [output, setOutput] = useState<Json>(() => initialValue(schema));
  let invalid = "";
  try {
    parseValue(schema, output);
  } catch (e) {
    invalid = workflowIssue(e);
  }
  return (
    <fieldset className="border p-2">
      <legend>Manual recovery</legend>
      <p role="alert">
        Operations may already have made changes. Retry can repeat those
        effects.
      </p>
      <button
        disabled={busy}
        onClick={() => void send({ kind: "retry", stepId })}
      >
        Retry step
      </button>
      <ValueEditor schema={schema} value={output} onChange={setOutput} />
      {invalid && <pre role="alert">{invalid}</pre>}
      <button
        disabled={busy || !!invalid}
        onClick={() => void send({ kind: "supply", stepId, output })}
      >
        Supply output and continue
      </button>
    </fieldset>
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
      className="rounded border border-amber-500/50 bg-amber-500/5 p-3 grid gap-3"
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
            <label key={o.label} className="!flex items-start gap-2 mb-2">
              <input
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
          <label>
            Your answer
            <input
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
      <button disabled={busy || answers.some((a) => !a.some((v) => v.trim()))}>
        Submit answers
      </button>
    </form>
  );
}
