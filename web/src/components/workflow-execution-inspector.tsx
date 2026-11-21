import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import type { WorkflowExecutionView } from "../../../src/protocol/workflow-executions.ts";
import { invocationTrail } from "../presentation/workflow-calls.ts";
import { attemptDuration } from "../presentation/workflow-execution.ts";
import { limitedLoops, loopProgress } from "../presentation/workflow-loops.ts";
import { useWorkflowResource } from "./workflow-api.ts";
import { WorkflowGraph } from "./workflow-graph.tsx";
import { WorkflowTranscript } from "./workflow-transcript.tsx";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

export type WorkflowMobileNavigation = {
  stepId: string;
  onSelect: (stepId: string) => void;
  onBack: () => void;
};

export function WorkflowExecutionInspector({
  view: rootView,
  detailBase,
  transcriptBase,
  placement = "right",
  mobileNavigation,
}: {
  view: WorkflowExecutionView;
  detailBase: string;
  transcriptBase: string;
  placement?: "right" | "bottom";
  mobileNavigation?: WorkflowMobileNavigation;
}) {
  const [invocationId, setInvocationId] = useState("");
  const [stepId, setStepId] = useState("");
  const [attempt, setAttempt] = useState<number>();
  const [tab, setTab] = useState<"Overview" | "Flow">("Overview");
  const nested = useWorkflowResource<WorkflowExecutionView>(
    invocationId ? `${detailBase}?invocationId=${encodeURIComponent(invocationId)}` : undefined,
    1000,
  );
  const root = rootView.execution;
  const view = invocationId ? nested.data : rootView;
  const execution = view?.execution;
  const shownStepId = mobileNavigation?.stepId ?? stepId;
  const step = execution?.definition.steps.find((item) => item.id === shownStepId);
  const record = execution?.steps[shownStepId];
  const showFlow = () => {
    setStepId("");
    mobileNavigation?.onBack();
  };
  const openInvocation = (id: string) => {
    setInvocationId(id);
    showFlow();
    setAttempt(undefined);
    setTab("Flow");
  };
  return (
    <section aria-label="Workflow execution inspection" className="grid min-w-0 gap-3 text-sm">
      <nav aria-label="Workflow invocation" className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" disabled={!invocationId} onClick={() => openInvocation("")}>
          {root.definition.name}
        </Button>
        {invocationTrail(root, invocationId).map((item) => (
          <span key={item.id} className="inline-flex items-center gap-1">
            <span aria-hidden>›</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={item.id === invocationId}
              onClick={() => openInvocation(item.id)}
            >
              {item.call} · {item.name} · Attempt {item.attempt}
            </Button>
          </span>
        ))}
      </nav>
      {nested.error && <p role="alert">{nested.error}</p>}
      {execution && view && (
        <>
          <h3 className="font-semibold">
            {execution.definition.name} ·{" "}
            {view.enquiries.length || view.permissions.length
              ? "awaiting input"
              : execution.status.replaceAll("-", " ")}
          </h3>
          <p>{attemptDuration(execution.startedAt, execution.finishedAt)}</p>
          <p>
            Spend:{" "}
            {view.spend
              ? `$${view.spend.costUSD.toFixed(4)} · ${view.spend.tokens.toLocaleString()} tokens`
              : "Unknown"}
          </p>
          {execution.status === "recovery-required" && (
            <div className="rounded-lg border border-status-awaiting/50 bg-status-awaiting/5 p-3">
              <p>Recovery required.</p>
              {limitedLoops(execution).map(([id, loop]) => (
                <p key={id}>
                  {execution.definition.steps.find((step) => step.id === id)?.name}:{" "}
                  {loopProgress(loop, execution.definition.loopSettings?.[id]?.maxTries ?? 3)}
                </p>
              ))}
            </div>
          )}
          {!!(view.enquiries.length || view.permissions.length) && (
            <section
              className="rounded-lg border border-status-awaiting/50 bg-status-awaiting/5 p-3"
              aria-label="Pending workflow input"
            >
              <h4 className="font-medium">Pending workflow input</h4>
              {[
                ...view.enquiries.map((item) => ({
                  key: `${item.subagentId}/${item.askId}`,
                  invocationId: item.invocationId,
                  stepId: item.stepId,
                  label: "Question",
                })),
                ...view.permissions.map((item) => ({
                  key: `${item.subagentId}/${item.callId}`,
                  invocationId: item.invocationId,
                  stepId: item.stepId,
                  label: `Permission · ${item.tool}`,
                })),
              ].map((item) => (
                <p key={item.key} className="mt-2 text-xs">
                  {item.invocationId && item.invocationId !== invocationId ? (
                    <Button size="sm" variant="link" onClick={() => openInvocation(item.invocationId!)}>
                      {invocationTrail(root, item.invocationId)
                        .map((part) => `${part.call} · ${part.name}`)
                        .join(" / ")}
                    </Button>
                  ) : (
                    <span className="font-medium">
                      {execution.definition.steps.find((step) => step.id === item.stepId)?.name ??
                        item.stepId}
                    </span>
                  )}
                  <span className="text-muted-foreground"> · {item.label} · pending</span>
                </p>
              ))}
            </section>
          )}
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (value === "Overview" || value === "Flow") setTab(value);
            }}
            className="contents"
          >
            <div className="min-w-0 border-b pb-2">
              <TabsList
                aria-label="Workflow execution view"
                className="mx-auto flex w-fit min-w-0 max-w-full"
              >
                {(["Overview", "Flow"] as const).map((name) => (
                  <TabsTrigger key={name} value={name} className="w-24 min-w-0 shrink px-2">
                    {name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="Overview" className="grid min-w-0 gap-3">
              <p className="text-xs text-muted-foreground">
                Original launch snapshot · read-only. Later workflow edits do not change this execution.
              </p>
              <p>
                {execution.definition.steps.length} steps · {execution.definition.backend} ·{" "}
                {new Date(execution.startedAt).toLocaleString()}
              </p>
              <h3 className="font-semibold">Original inputs</h3>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {JSON.stringify(execution.input, null, 2)}
              </pre>
              <details>
                <summary className="cursor-pointer font-medium">Original workflow</summary>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                  {JSON.stringify(execution.definition, null, 2)}
                </pre>
              </details>
              {Object.entries(execution.steps)
                .filter(([, record]) => record.attempts.at(-1)?.error)
                .map(([id, record]) => (
                  <p key={id} className="text-destructive">
                    {execution.definition.steps.find((step) => step.id === id)?.name}:{" "}
                    {record.attempts.at(-1)?.error?.message}
                  </p>
                ))}
              {execution.result !== undefined && (
                <>
                  <h3 className="font-semibold">Result</h3>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {JSON.stringify(execution.result, null, 2)}
                  </pre>
                </>
              )}
            </TabsContent>
            <TabsContent value="Flow" keepMounted className="grid min-w-0 gap-3">
              <div className={step ? "hidden" : "contents"} aria-hidden={step ? true : undefined}>
                <WorkflowGraph
                  key={`${execution.id}/${invocationId}/${placement}`}
                  definition={execution.definition}
                  execution={execution}
                  orientation={placement === "bottom" ? "horizontal" : "vertical"}
                  awaitingSteps={[...view.enquiries, ...view.permissions]
                    .filter((item) => (item.invocationId ?? "") === invocationId)
                    .map((item) => item.stepId)}
                  selectedStepId={shownStepId}
                  onSelect={(id) => {
                    setStepId(id);
                    mobileNavigation?.onSelect(id);
                    setAttempt(undefined);
                  }}
                />
              </div>
              {step && (
                <Button size="sm" variant="ghost" className="min-h-10 justify-self-start" onClick={showFlow}>
                  <ChevronLeft aria-hidden data-icon="inline-start" />
                  Back to flow
                </Button>
              )}
              {step && record && (
                <div className="grid gap-2">
                  <h3 className="font-semibold">
                    {step.name} · {record.status}
                  </h3>
                  {step.kind === "workflow" &&
                    Object.values(root.invocations ?? {})
                      .filter(
                        (item) =>
                          (item.parentInvocationId ?? "") === invocationId &&
                          item.callStepId === step.id &&
                          item.callAttempt === (attempt ?? record.attempts.at(-1)?.number),
                      )
                      .map((item) => (
                        <Button
                          key={item.id}
                          size="sm"
                          variant="outline"
                          className="justify-self-start"
                          onClick={() => openInvocation(item.id)}
                        >
                          Open called workflow · {item.status.replaceAll("-", " ")}
                        </Button>
                      ))}
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
                  <label className="grid gap-1">
                    <span className="font-medium">Attempt</span>
                    <Select
                      value={attempt ?? record.attempts.at(-1)?.number ?? 1}
                      onValueChange={(value) => value !== null && setAttempt(value)}
                    >
                      <SelectTrigger aria-label="Attempt">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {record.attempts.map((a) => (
                          <SelectItem key={a.number} value={a.number}>
                            Attempt {a.number} · {a.action}
                            {a.error ? " · failed" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {record.attempts
                    .filter((a) => a.number === (attempt ?? record.attempts.at(-1)?.number))
                    .map((a) => (
                      <details key={a.number} open>
                        <summary className="cursor-pointer font-medium">
                          Attempt {a.number} · {a.action} · {attemptDuration(a.startedAt, a.finishedAt)}
                        </summary>
                        {a.loops?.map((loop) => (
                          <p key={loop.headerId} className="text-xs text-muted-foreground">
                            Loop ·{" "}
                            {execution.definition.steps.find((step) => step.id === loop.headerId)?.name ??
                              loop.headerId}{" "}
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
                        <WorkflowTranscript
                          key={`${execution.id}/${invocationId}/${step.id}/${a.number}`}
                          base={transcriptBase}
                          sessionId={root.sessionId}
                          stepId={step.id}
                          attempt={a.number}
                          legacy={!view.historyComplete}
                          completed={a.finishedAt !== undefined}
                          invocationId={invocationId || undefined}
                        />
                        {a.error && (
                          <p role="alert">
                            {a.error.kind}: {a.error.message}
                          </p>
                        )}
                      </details>
                    ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}
