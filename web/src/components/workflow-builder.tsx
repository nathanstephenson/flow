import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkflowDefinition } from "../../../src/protocol/workflows.ts";
import type { WorkflowBuilderView } from "../../../src/protocol/workflow-builder.ts";
import type { Capabilities, EffortLevel, ModelInfo } from "../../../src/protocol/events.ts";
import { effortForWorkflowModelSelection } from "../../../src/client/workflow-effort.ts";
import { initialWorkflowEffort } from "../../../src/client/model-choices.ts";
import type { ComposerActions } from "../composer-actions.ts";
import { useDraftStash } from "../drafts.ts";
import { useHost } from "../host.tsx";
import { useModelCatalogue } from "../models.ts";
import type { Chrome } from "../store/contract.ts";
import { createWorkflowBuilderTranscript } from "../store/workflow-builder-view.ts";
import { workflowApi } from "./workflow-api.ts";
import { Composer } from "./composer.tsx";
import { TranscriptView } from "./transcript-view.tsx";
import { Button } from "./ui/button.tsx";

/** Sidebar conversation over a private workflow file; Apply and Save remain separate decisions. */
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
  const [view, setView] = useState<WorkflowBuilderView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const action = useRef(false);
  // Fence GETs started both before and during a mutation, even if they return after its response.
  const revision = useRef(0);
  const baseline = useRef<string | undefined>(undefined);
  const key = `workflow builder ${definition.id}`;
  const drafts = useDraftStash([key]);
  const [transcript] = useState(() => createWorkflowBuilderTranscript(key));
  const running = view?.status === "running" || !!view?.stopping;
  const changed = baseline.current !== undefined && JSON.stringify(definition) !== baseline.current;
  const hasDraft = view && JSON.stringify(view.definition) !== baseline.current;

  useLayoutEffect(() => {
    transcript.view.start();
    return () => transcript.view.stop();
  }, [transcript]);
  useLayoutEffect(() => { if (view) transcript.update(view); }, [transcript, view]);
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
      const requestedAt = revision.current;
      try {
        const next = await workflowApi<WorkflowBuilderView>(`/api/workflow-builders/${view.id}`, "GET", undefined, controller.signal);
        if (!controller.signal.aborted && !action.current && requestedAt === revision.current) { setView(next); setError(""); }
      } catch (reason) {
        if (!controller.signal.aborted && !action.current && requestedAt === revision.current) setError(reason instanceof Error ? reason.message : "Builder unavailable");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [view?.id]);

  const send = async (text: string): Promise<WorkflowBuilderView | undefined> => {
    if (action.current || running || !text.trim() || changed || (!view && (invalidEffort || loading))) return undefined;
    action.current = true;
    revision.current++;
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
          return undefined;
        }
        id.current = builderId;
        baseline.current = snapshot;
        setView(created);
      }
      const next = await workflowApi<WorkflowBuilderView>(`/api/workflow-builders/${builderId}/messages`, "POST", { text });
      if (alive.current) setView(next);
      return next;
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "Builder request failed");
      return undefined;
    } finally {
      revision.current++;
      action.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const chooseModel = (next: ModelInfo) => {
    if (view || id.current || action.current) return;
    setEffort(effortForWorkflowModelSelection(modelId, effectiveEffort, next));
    setModelId(next.id);
  };
  const actions: ComposerActions = {
    send: text => send(text),
    setModel: value => { const next = listing?.models.find(item => item.id === value); if (next) chooseModel(next); },
    setEffort: value => { if (!view && !id.current && !action.current) setEffort(value); },
    setPermissionMode: () => {}, switchBranch: async () => false, listSkills: async () => [],
    abort: async () => {
      if (!id.current || action.current || view?.stopping) return;
      action.current = true;
      revision.current++;
      setBusy(true);
      try {
        const next = await workflowApi<WorkflowBuilderView>(`/api/workflow-builders/${id.current}/abort`, "POST", {});
        if (alive.current) setView(next);
      } catch (reason) {
        if (alive.current) setError(reason instanceof Error ? reason.message : "Could not stop builder");
        throw reason;
      } finally { revision.current++; action.current = false; if (alive.current) setBusy(false); }
    },
  };
  const capabilities = useMemo<Capabilities>(() => ({
    models: listing?.models ?? [], providers: [], compaction: false, fork: false,
    permissions: false, enquiries: false, subagents: false,
  }), [listing?.models]);
  const chrome: Chrome = {
    ...transcript.view.getChrome(), status: running ? "running" : "idle", backend: definition.backend,
    scope: view?.scope, model, effort: effectiveEffort, capabilities, branch: undefined, permissionMode: undefined,
    contextUsage: view?.contextUsage ? { ...view.contextUsage, ...(view.spend ? { spend: view.spend } : {}) } : undefined,
  };
  const unavailable = changed ? "Close and reopen the builder to use the latest editor draft."
    : view?.stopping ? "Stopping builder…"
      : busy ? (running ? "Stopping builder…" : view ? "Sending message…" : "Starting builder…")
        : running ? "Builder is working…"
          : !view && loading ? "Discovering builder models…"
            : !view && invalidEffort ? "Choose a supported Effort before starting." : undefined;

  return <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="Workflow builder agent">
    <header className="shrink-0 space-y-2 border-b p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Builder agent</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>Close builder</Button>
      </div>
      <p className="text-xs text-muted-foreground">Edits only its private workflow.json, with real MCP tool schemas available. Apply here, then Save workflow in the editor.</p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Read Scope and safety</summary>
        <p className="mt-1 break-all">{view?.scope ?? definition.projectId ?? "The Project Root (or Flow’s starting directory)"}. No shell, external MCP calls, Subagents, Skills, or Attachments. MCP discovery is host-owned; configured stdio servers may start in the authoring Scope under the current isolation policy. Closing discards this conversation. Model and Effort are fixed after starting.</p>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!hasDraft || running || busy || changed} onClick={() => {
          if (view && !changed) { onApply(view.definition); onClose(); }
        }}>Apply draft to editor</Button>
        {view?.spend && <span className="text-xs text-muted-foreground">Spend: ${view.spend.costUSD.toFixed(4)}</span>}
      </div>
      {hasDraft && <details className="rounded-lg border p-2">
        <summary className="cursor-pointer text-xs font-medium">Review draft · {view.definition.steps.length} steps</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(view.definition, null, 2)}</pre>
      </details>}
      {(problem || listing?.problem) && !view && <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground">{problem || listing?.problem}</p>
        <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void refresh()}>Check again</Button>
      </div>}
      {(error || view?.error) && <p className="text-xs text-destructive" role="alert">{error || view?.error}</p>}
      {changed && <p className="text-xs text-destructive" role="alert">The editor changed since this builder started. Close and reopen the builder to use the latest draft.</p>}
    </header>
    <div data-pane="" className="relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)]" role="log" aria-label="Builder conversation">
      <TranscriptView view={transcript.view} query="" />
      <Composer id={key} chrome={chrome} actions={actions} drafts={drafts}
        inputLabel="Builder message" placeholder="Describe the workflow you want to build or change…"
        unavailable={unavailable} controls={{ branches: false, permissions: false, disabled: busy || loading || !!view }}
        attachmentsEnabled={false} skillsEnabled={false} abortDisabled={busy || !!view?.stopping}
        abortLabel={view?.stopping ? "Stopping builder…" : "Stop builder"}
        authorisingSummary={undefined} onShowSubagents={() => {}} />
    </div>
  </section>;
}
