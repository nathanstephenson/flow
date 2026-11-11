import { useEffect, useRef, useState } from "react";
import type { WorkflowDefinition, WorkflowStep } from "../../../src/protocol/workflows.ts";
import { selectWorkflowContract, type WorkflowCallStep, type WorkflowCatalogue } from "../presentation/workflow-calls.ts";
import { workflowIssue } from "../presentation/workflows.ts";
import { workflowApi } from "./workflow-api.ts";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

export function WorkflowCallEditor({ definition, step, onChange }: {
  definition: WorkflowDefinition;
  step: WorkflowCallStep;
  onChange: (step: WorkflowStep) => void;
}) {
  const [catalogue, setCatalogue] = useState<WorkflowCatalogue>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | undefined>(undefined);
  const current = useRef({ definition, step, onChange });
  current.current = { definition, step, onChange };
  useEffect(() => {
    const controller = new AbortController();
    setCatalogue(undefined);
    setError("");
    void workflowApi<WorkflowCatalogue>("/api/workflow-catalogue", "GET", undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setCatalogue(data); })
      .catch(error => { if (!controller.signal.aborted) setError(workflowIssue(error)); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [definition.id, definition.backend, refresh]);
  const choices = catalogue?.workflows.filter(item => item.backend === definition.backend && item.id !== definition.id) ?? [];
  const selected = choices.find(item => item.id === step.workflowId);
  const select = async (id: string) => {
    request.current?.abort();
    const controller = request.current = new AbortController();
    const definitionId = definition.id;
    const stepId = step.id;
    setLoading(true);
    setError("");
    try {
      const data = await workflowApi<WorkflowCatalogue>("/api/workflow-catalogue", "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      const latest = current.current;
      if (latest.definition.id !== definitionId || latest.step.id !== stepId) return;
      const selection = data.workflows.find(item => item.id === id && item.id !== definitionId && item.backend === latest.definition.backend);
      if (!selection) throw new Error("Saved workflow is unavailable or has a different Backend Adapter");
      setCatalogue(data);
      latest.onChange(selectWorkflowContract(latest.step, selection));
    } catch (error) {
      if (!controller.signal.aborted) setError(workflowIssue(error));
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };
  return <fieldset className="grid gap-3 rounded-lg border p-3">
    <legend className="px-1 text-sm font-medium">Saved workflow</legend>
    <p className="text-xs text-muted-foreground">Calls this workflow and waits for its result in the owning Agent Session’s Scope. Only matching Backend Adapters are offered.</p>
    <Select value={selected?.id ?? ""} disabled={!catalogue} onValueChange={id => { if (id) void select(id); }}>
      <SelectTrigger aria-label="Called workflow"><SelectValue>{selected?.name ?? (step.workflowId === "unselected" ? "Select saved workflow" : `${step.workflowId} · unavailable`)}</SelectValue></SelectTrigger>
      <SelectContent>{choices.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
    </Select>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={loading || !selected} onClick={() => void select(step.workflowId)}>{loading ? "Loading contract…" : "Refresh contract"}</Button>
      <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Refresh catalogue</Button>
    </div>
    <p className="text-xs text-muted-foreground">Input and result contracts stay fixed until you select or refresh. Refresh keeps mappings; repair mappings if the contract changes. Result fields use terminal step names.</p>
    {catalogue && !choices.length && <p className="text-xs text-muted-foreground">No saved workflows with this Backend Adapter are available.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!!catalogue?.errors.length && <p className="text-xs text-muted-foreground">{catalogue.errors.length} invalid saved workflows cannot be selected.</p>}
    <details><summary className="cursor-pointer text-xs font-medium">Saved contracts</summary><pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(step.contract, null, 2)}</pre></details>
  </fieldset>;
}
