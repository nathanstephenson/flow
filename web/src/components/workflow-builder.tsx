import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowDefinition } from "../../../src/protocol/workflows.ts";
import type { WorkflowBuilderView } from "../../../src/protocol/workflow-builder.ts";
import type { EffortLevel, ModelInfo } from "../../../src/protocol/events.ts";
import { parseMarkdown } from "../../../src/client/markdown.ts";
import { effortForWorkflowModelSelection } from "../../../src/client/workflow-effort.ts";
import { initialWorkflowEffort } from "../../../src/client/model-choices.ts";
import { useHost } from "../host.tsx";
import { useModelCatalogue } from "../models.ts";
import { workflowApi } from "./workflow-api.ts";
import { ModelPicker } from "./model-picker.tsx";
import { ConfiguredEffortSelect } from "./effort-select.tsx";
import { Markdown } from "./markdown.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";

function BuilderMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={role === "user" ? "ml-auto max-w-[90%] rounded-lg bg-muted p-3" : "min-w-0 py-2"}>
    <p className="mb-1 text-xs font-medium text-muted-foreground">{role === "user" ? "You" : "Builder agent"}</p>
    <Markdown blocks={blocks} query="" />
  </div>;
}

/** An isolated draft: applying it is explicit and never saves the definition implicitly. */
export function WorkflowBuilder({ definition, onApply, onClose }: {
  definition: WorkflowDefinition;
  onApply: (definition: WorkflowDefinition) => void;
  onClose: () => void;
}) {
  const { config } = useHost();
  const { catalogue, loading, problem, refresh } = useModelCatalogue();
  const listing = catalogue?.find(item => item.backend === definition.backend);
  const [modelId, setModelId] = useState(config.providers?.defaults?.[definition.backend] ?? "");
  const [effort, setEffort] = useState<EffortLevel | undefined>(config.providers?.efforts?.[definition.backend]);
  const model = listing?.models.find(item => item.id === modelId) ?? (!modelId ? listing?.models[0] : undefined);
  const effectiveEffort = effort ?? (model ? initialWorkflowEffort(model) : "off");
  const invalidEffort = !!model?.effortLevels?.length && !model.effortLevels.includes(effectiveEffort);
  const [text, setText] = useState("");
  const [view, setView] = useState<WorkflowBuilderView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const action = useRef(false);
  const baseline = useRef<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const running = view?.status === "running" || !!view?.stopping;
  const changed = baseline.current !== undefined && JSON.stringify(definition) !== baseline.current;
  const hasDraft = view && JSON.stringify(view.definition) !== baseline.current;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (id.current) void workflowApi(`/api/workflow-builders/${id.current}`, "DELETE").catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!view?.id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await workflowApi<WorkflowBuilderView>(`/api/workflow-builders/${view.id}`, "GET", undefined, controller.signal);
        if (!controller.signal.aborted) { setView(next); setError(""); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Builder unavailable");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [view?.id]);
  useEffect(() => {
    if (pinned.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [view?.messages]);

  const send = async () => {
    if (action.current || running || !text.trim() || changed || (!view && (invalidEffort || loading))) return;
    action.current = true;
    setBusy(true);
    setError("");
    try {
      let builderId = id.current;
      if (!builderId) {
        const snapshot = JSON.stringify(definition);
        const created = await workflowApi<WorkflowBuilderView>("/api/workflow-builders", "POST", {
          definition, ...(model ? { modelId: model.id, effort: model.effortLevels?.length ? effectiveEffort : "off" } : {}),
        });
        builderId = created.id;
        if (!alive.current) {
          await workflowApi(`/api/workflow-builders/${builderId}`, "DELETE");
          return;
        }
        id.current = builderId;
        baseline.current = snapshot;
        setView(created);
      }
      const next = await workflowApi<WorkflowBuilderView>(`/api/workflow-builders/${builderId}/messages`, "POST", { text });
      if (alive.current) { setView(next); setText(""); }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "Builder request failed");
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const chooseModel = (next: ModelInfo) => {
    setEffort(effortForWorkflowModelSelection(modelId, effectiveEffort, next));
    setModelId(next.id);
  };

  return <section className="grid min-w-0 gap-3 rounded-lg border p-4" aria-label="Workflow builder agent">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Builder agent</h3>
      <Button size="sm" variant="ghost" onClick={onClose}>Close builder</Button>
    </div>
    <p className="text-xs text-muted-foreground">
      Reads {definition.projectId ?? "the Project Root (or Flow’s starting directory)"}. Can edit only its own workflow.json draft. No shell, MCP tools or Subagents. Apply the draft to the editor, then save when ready. Closing discards this conversation.
    </p>
    {view?.scope && <p className="break-all text-xs text-muted-foreground">Read Scope: {view.scope}</p>}
    {!view && <div className="flex flex-wrap items-center gap-2">
      <div className="grid gap-1">
        <span className="text-xs font-medium">Model · {definition.backend}</span>
        <ModelPicker models={listing?.models ?? []} model={model ?? { id: modelId, label: modelId || "Select model" }} onSelect={value => {
          const next = listing?.models.find(item => item.id === value);
          if (next) chooseModel(next);
        }} disabled={busy || loading} />
      </div>
      {model?.effortLevels?.length ? <label className="grid w-36 gap-1">
        <span className="text-xs font-medium">Effort</span>
        <ConfiguredEffortSelect value={effectiveEffort} levels={model.effortLevels} ariaLabel="Builder Effort" disabled={busy} onChange={value => value && setEffort(value)} />
      </label> : null}
      {(problem || listing?.problem) && <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground">{problem || listing?.problem}</p>
        <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void refresh()}>Check again</Button>
      </div>}
      {invalidEffort && <p className="text-xs text-destructive" role="alert">Choose a supported Builder Effort before starting.</p>}
    </div>}
    {!!view?.messages.length && <div ref={scroller} className="grid max-h-96 min-w-0 gap-2 overflow-auto" role="log" aria-label="Builder conversation" onScroll={() => {
      const element = scroller.current;
      if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    }}>
      {view.messages.map(message => <BuilderMessage key={message.id} role={message.role} text={message.text} />)}
    </div>}
    {hasDraft && <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">Review draft · {view.definition.steps.length} steps</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(view.definition, null, 2)}</pre>
    </details>}
    {(error || view?.error) && <p className="text-xs text-destructive" role="alert">{error || view?.error}</p>}
    {changed && <p className="text-xs text-destructive" role="alert">The editor changed since this builder started. Close and reopen the builder to use the latest draft.</p>}
    <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void send(); }}>
      <Textarea aria-label="Builder message" placeholder="Describe the workflow you want to build or change…" value={text} onChange={event => setText(event.target.value)} disabled={busy || running || changed} rows={3} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={busy || running || changed || (!view && (invalidEffort || loading)) || !text.trim()}>{view?.stopping ? "Stopping…" : busy ? "Starting…" : running ? "Building…" : "Send to builder"}</Button>
        {running && <Button size="sm" type="button" variant="outline" disabled={busy || view?.stopping} onClick={() => {
          setBusy(true);
          void workflowApi<WorkflowBuilderView>(`/api/workflow-builders/${view.id}/abort`, "POST", {}).then(next => { if (alive.current) setView(next); }).catch(reason => { if (alive.current) setError(String(reason)); }).finally(() => { if (alive.current) setBusy(false); });
        }}>Stop builder</Button>}
        <Button size="sm" type="button" variant="outline" disabled={!hasDraft || running || busy || changed} onClick={() => {
          if (view && !changed) { onApply(view.definition); onClose(); }
        }}>Apply draft to editor</Button>
        {view?.spend && <span className="text-xs text-muted-foreground">Spend: ${view.spend.costUSD.toFixed(4)}</span>}
      </div>
    </form>
  </section>;
}
