import { useEffect, useState } from "react";
import type {
  WorkflowOccurrence,
  WorkflowOccurrencePage,
  WorkflowSchedule,
  WorkflowScheduleSettings,
} from "../../../src/protocol/workflow-schedules.ts";
import type { WorkflowExecutionView } from "../../../src/protocol/workflow-executions.ts";
import type { Json, WorkflowDefinition } from "../../../src/protocol/workflows.ts";
import { parseValue } from "../../../src/workflows/schema.ts";
import { scheduleState, scheduleTiming, sharedDirectoryWarning } from "../presentation/workflow-schedules.ts";
import { useHost } from "../host.tsx";
import { useBranches } from "../branches.ts";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { useScheduleMutation } from "./use-schedule-mutation.ts";
import { initialValue, ValueEditor } from "./workflow-editors.tsx";
import { WorkflowExecutionInspector } from "./workflow-execution-inspector.tsx";
import { SettingsGroup } from "./settings-parts.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import "./workflows.css";

const base = "/api/workflow-schedules";
type SchedulePageProps = {
  scheduleId?: string | undefined;
  occurrenceId?: string | undefined;
  onNavigate: (scheduleId?: string, occurrenceId?: string) => void;
  onSession: (id: string) => void;
};

export function WorkflowSchedulesPage(props: SchedulePageProps) {
  return <SchedulesView key={`${props.scheduleId ?? ""}/${props.occurrenceId ?? ""}`} {...props} />;
}

function SchedulesView({ scheduleId, occurrenceId, onNavigate, onSession }: SchedulePageProps) {
  const list = useWorkflowResource<{ schedules: WorkflowSchedule[]; cleanupWarnings: unknown[] }>(base);
  const saved = useWorkflowResource<{ schedule: WorkflowSchedule }>(
    scheduleId ? `${base}/${encodeURIComponent(scheduleId)}` : undefined,
  );
  const [editor, setEditor] = useState<{ mode: "" | "new" | "edit"; key: number }>({ mode: "", key: 0 });
  const schedule = saved.data?.schedule;
  return (
    <main className="min-h-0 overflow-y-auto p-4 pt-12 sm:p-8" aria-label="Workflow schedules">
      <div className="mx-auto grid max-w-5xl gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setEditor({ mode: "", key: 0 });
                onNavigate();
              }}
            >
              All schedules
            </Button>
            <Button onClick={() => setEditor((current) => ({ mode: "new", key: current.key + 1 }))}>
              New schedule
            </Button>
          </div>
        </header>
        <p className="text-sm text-muted-foreground">
          The Session Host must remain running. Enabling waits until the next future occurrence; it never runs
          immediately. There is no catch-up after downtime. Each occurrence reads the latest saved workflow
          and called definitions, then keeps its own immutable snapshot. Terminal history is retained for
          seven days; input and recovery waits are kept.
        </p>
        {(list.error || saved.error) && (
          <p role="alert" className="text-destructive">
            {list.error || saved.error}
          </p>
        )}
        {editor.mode ? (
          <ScheduleForm
            key={editor.key}
            schedule={editor.mode === "edit" ? schedule : undefined}
            onSaved={(id) => {
              setEditor({ mode: "", key: 0 });
              onNavigate(id);
            }}
          />
        ) : occurrenceId ? (
          <OccurrenceDetail id={occurrenceId} onSession={onSession} />
        ) : schedule ? (
          <ScheduleDetail
            schedule={schedule}
            onEdit={() => setEditor((current) => ({ mode: "edit", key: current.key + 1 }))}
            onNavigate={onNavigate}
          />
        ) : (
          <>
            <section aria-label="Saved schedules" className="grid gap-3">
              {list.data?.schedules.map((schedule) => (
                <button
                  key={schedule.id}
                  className="rounded-lg border p-4 text-left hover:bg-muted focus-visible:outline-2"
                  onClick={() => onNavigate(schedule.id)}
                >
                  <strong>{schedule.name}</strong>
                  <span className="block text-sm">
                    {scheduleState(schedule)} · {scheduleTiming(schedule.timing)} · limit{" "}
                    {schedule.concurrency}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Next:{" "}
                    {schedule.nextDue === undefined ? "paused" : new Date(schedule.nextDue).toLocaleString()}
                  </span>
                </button>
              ))}
              {list.data?.schedules.length === 0 && (
                <p>No schedules yet. Create one from a saved Workflow Definition.</p>
              )}
            </section>
            {!!list.data?.cleanupWarnings.length && (
              <details>
                <summary>Preserved worktree cleanup warnings</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(list.data.cleanupWarnings, null, 2)}
                </pre>
              </details>
            )}
            <History onOpen={(id) => onNavigate(undefined, id)} />
          </>
        )}
      </div>
    </main>
  );
}

function ScheduleDetail({
  schedule,
  onEdit,
  onNavigate,
}: {
  schedule: WorkflowSchedule;
  onEdit: () => void;
  onNavigate: SchedulePageProps["onNavigate"];
}) {
  const { busy, error, mutate } = useScheduleMutation();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <h2 className="text-xl font-semibold">
        {schedule.name} · {scheduleState(schedule)}
      </h2>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p>
        {scheduleTiming(schedule.timing)} · Next:{" "}
        {schedule.nextDue === undefined ? "paused" : new Date(schedule.nextDue).toLocaleString()} · Limit{" "}
        {schedule.concurrency}
      </p>
      <p className="break-all text-sm">
        Project: {schedule.projectId} ·{" "}
        {schedule.worktree ? `Fresh worktree from local ${schedule.worktree.from}` : "Shared directory"}
      </p>
      {sharedDirectoryWarning(schedule.worktree) && (
        <p className="rounded-md border p-3 text-sm">{sharedDirectoryWarning(schedule.worktree)}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || schedule.deletedAt !== undefined} onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="outline"
          disabled={busy || schedule.deletedAt !== undefined}
          onClick={() =>
            void mutate(
              `${base}/${schedule.id}/${schedule.enabled ? "pause" : "enable"}`,
              "POST",
              { revision: schedule.revision },
              () => onNavigate(),
            )
          }
        >
          {schedule.enabled ? "Pause" : "Enable"}
        </Button>
        <Button
          variant="destructive"
          disabled={busy || schedule.deletedAt !== undefined}
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              Future occurrences will stop. Existing occurrences and history remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep schedule</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void mutate(`${base}/${schedule.id}`, "DELETE", { revision: schedule.revision }, () =>
                  onNavigate(),
                );
              }}
            >
              Delete schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <History scheduleId={schedule.id} onOpen={(id) => onNavigate(undefined, id)} />
    </>
  );
}

export function ScheduleForm({
  schedule: polledSchedule,
  onSaved,
}: {
  schedule?: WorkflowSchedule | undefined;
  onSaved: (id: string) => void;
}) {
  const [schedule] = useState(polledSchedule);
  const { config } = useHost();
  const definitions = useWorkflowResource<{ workflows: WorkflowDefinition[] }>("/api/workflows");
  const [name, setName] = useState(schedule?.name ?? "");
  const [workflowId, setWorkflow] = useState(schedule?.workflowId ?? "");
  const [projectId, setProject] = useState(schedule?.projectId ?? "");
  const [input, setInput] = useState<Json>(schedule?.input ?? {});
  const [connections, setConnections] = useState(schedule?.mcpConnectionIds ?? []);
  const [timing, setTiming] = useState<WorkflowScheduleSettings["timing"]>(
    schedule?.timing ?? { kind: "interval", value: 5, unit: "minutes" },
  );
  const [concurrency, setConcurrency] = useState(schedule?.concurrency ?? 3);
  const [worktree, setWorktree] = useState(!!schedule?.worktree);
  const [from, setFrom] = useState(schedule?.worktree?.from ?? "");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [preview, setPreview] = useState("");
  const [validation, setValidation] = useState("");
  const { busy, error, mutate } = useScheduleMutation();
  const branches = useBranches(projectId || undefined);
  const definition = definitions.data?.workflows.find((candidate) => candidate.id === workflowId);
  useEffect(() => {
    const controller = new AbortController();
    setPreview("");
    const timer = setTimeout(() => {
      void workflowApi<{ nextDue: number }>(`${base}/preview`, "POST", { timing }, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setPreview(new Date(result.nextDue).toLocaleString());
        },
        () => {
          if (!controller.signal.aborted) setPreview("Invalid timing");
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [timing]);
  return (
    <form
      className="grid gap-6 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setValidation("");
        if (!definition) {
          setValidation("Choose a saved workflow");
          return;
        }
        if (!projectId || (worktree && !from)) {
          setValidation(worktree && !from ? "Choose a local base branch" : "Choose an opted-in Project");
          return;
        }
        let parsed: Json;
        try {
          parsed = parseValue(definition.inputSchema, input);
        } catch {
          setValidation("Inputs do not match this workflow");
          return;
        }
        const settings = {
          name,
          workflowId,
          projectId,
          input: parsed,
          mcpConnectionIds: connections,
          timing,
          concurrency,
          ...(worktree ? { worktree: { from } } : {}),
        };
        void mutate<{ schedule: WorkflowSchedule }>(
          schedule ? `${base}/${schedule.id}` : base,
          schedule ? "PUT" : "POST",
          { settings, enabled, ...(schedule ? { revision: schedule.revision } : {}) },
          (result) => onSaved(result.schedule.id),
        );
      }}
    >
      <SettingsGroup title={schedule ? "Edit schedule" : "New schedule"}>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Name</span>
          <Input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Workflow</span>
          <Select
            value={workflowId}
            onValueChange={(value) => {
              if (value === null) return;
              setWorkflow(value);
              const next = definitions.data?.workflows.find((candidate) => candidate.id === value);
              if (next) setInput(initialValue(next.inputSchema));
            }}
          >
            <SelectTrigger className="w-full" aria-label="Workflow">
              <SelectValue>{definition?.name ?? "Choose workflow"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Choose workflow</SelectItem>
              {definitions.data?.workflows.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Project</span>
          <Select
            value={projectId}
            onValueChange={(value) => {
              if (value !== null) {
                setProject(value);
                setFrom("");
              }
            }}
          >
            <SelectTrigger className="w-full" aria-label="Project">
              <SelectValue>
                {config.projectList?.find((project) => project.path === projectId)?.name ??
                  (projectId || "Choose opted-in Project")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Choose opted-in Project</SelectItem>
              {config.projectList
                ?.filter((project) => !project.missing)
                .map((project) => (
                  <SelectItem key={project.path} value={project.path}>
                    {project.name} · {project.path}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
      </SettingsGroup>
      <SettingsGroup title="Timing">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Recurrence</span>
          <Select
            value={timing.kind}
            onValueChange={(value) => {
              if (value !== null)
                setTiming(
                  value === "daily"
                    ? {
                        kind: "daily",
                        time: "09:00",
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                      }
                    : { kind: "interval", value: 5, unit: "minutes" },
                );
            }}
          >
            <SelectTrigger className="w-full" aria-label="Recurrence">
              <SelectValue>
                {timing.kind === "daily" ? "Daily (local civil time)" : "Interval (elapsed time)"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="interval">Interval (elapsed time)</SelectItem>
              <SelectItem value="daily">Daily (local civil time)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {timing.kind === "interval" ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Every</span>
              <Input
                type="number"
                min={1}
                step={1}
                required
                value={timing.value}
                onChange={(event) => setTiming({ ...timing, value: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Unit</span>
              <Select
                value={timing.unit}
                onValueChange={(value) => {
                  if (value === "minutes" || value === "hours" || value === "days")
                    setTiming({ ...timing, unit: value });
                }}
              >
                <SelectTrigger className="w-full" aria-label="Unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["minutes", "hours", "days"].map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Local time</span>
              <Input
                type="time"
                required
                value={timing.time}
                onChange={(event) => setTiming({ ...timing, time: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">IANA timezone</span>
              <Input
                required
                value={timing.timezone}
                onChange={(event) => setTiming({ ...timing, timezone: event.target.value })}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Spring-forward gaps are skipped. Fall-back repeats use the first occurrence only.
            </p>
          </>
        )}
        <p aria-live="polite" className="text-sm">
          Next future run after saving or enabling:{" "}
          {schedule?.enabled && enabled && JSON.stringify(schedule.timing) === JSON.stringify(timing)
            ? new Date(schedule.nextDue!).toLocaleString()
            : preview || "calculating…"}
        </p>
      </SettingsGroup>
      <SettingsGroup title="Execution">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Concurrent occurrences</span>
          <Input
            type="number"
            required
            min={1}
            max={100}
            step={1}
            value={concurrency}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
          <span className="text-xs text-muted-foreground">
            Includes provisioning and input/recovery waits.
          </span>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">Fresh worktree per occurrence</span>
          <Switch
            checked={worktree}
            onCheckedChange={(checked) => {
              setWorktree(checked);
              if (checked) branches.load();
            }}
          />
        </label>
        {worktree ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Local base branch</span>
            <Select
              value={from}
              onOpenChange={(open) => {
                if (open) branches.load();
              }}
              onValueChange={(value) => {
                if (value !== null) setFrom(value);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Local base branch">
                <SelectValue>{from || "Choose local branch"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Choose local branch</SelectItem>
                {from && !branches.list?.branches.includes(from) && (
                  <SelectItem value={from}>{from}</SelectItem>
                )}
                {branches.list?.branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              Uses its current local commit; no fetch and no uncommitted source changes are copied.
            </span>
          </label>
        ) : (
          <p className="rounded-md border p-3 text-sm">{sharedDirectoryWarning(undefined)}</p>
        )}
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">MCP connections</legend>
          {config.mcp?.map((connection) => (
            <label key={connection.id} className="flex items-center justify-between gap-4">
              <span className="text-sm">{connection.name}</span>
              <Switch
                checked={connections.includes(connection.id)}
                onCheckedChange={(checked) =>
                  setConnections(
                    checked
                      ? [...connections, connection.id]
                      : connections.filter((id) => id !== connection.id),
                  )
                }
              />
            </label>
          ))}
        </fieldset>
        {definition && (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Fixed typed inputs</legend>
            <ValueEditor schema={definition.inputSchema} value={input} onChange={setInput} />
          </fieldset>
        )}
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">Enabled (never runs immediately)</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>
      </SettingsGroup>
      {(validation || error || definitions.error) && (
        <p role="alert" className="text-destructive">
          {validation || error || definitions.error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="justify-self-start">
        {busy ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}

function History({ scheduleId, onOpen }: { scheduleId?: string; onOpen: (id: string) => void }) {
  const [before, setBefore] = useState<string>();
  const path = scheduleId ? `${base}/${encodeURIComponent(scheduleId)}/history` : "/api/workflow-occurrences";
  const history = useWorkflowResource<WorkflowOccurrencePage>(
    `${path}?limit=25${before ? `&before=${encodeURIComponent(before)}` : ""}`,
  );
  return (
    <section aria-label="Occurrence history" className="grid gap-2">
      <h2 className="text-lg font-semibold">Occurrence history</h2>
      {history.error && <p role="alert">{history.error}</p>}
      {history.data?.occurrences.map((occurrence) => (
        <button
          className="rounded-md border p-3 text-left hover:bg-muted"
          key={occurrence.id}
          onClick={() => onOpen(occurrence.id)}
        >
          <strong>{occurrence.settings.name}</strong> · {occurrence.status.replaceAll("-", " ")}
          <span className="block text-xs">
            Scheduled {new Date(occurrence.scheduledAt).toLocaleString()}
            {occurrence.missedThrough
              ? ` · missed through ${new Date(occurrence.missedThrough).toLocaleString()}`
              : ""}
          </span>
        </button>
      ))}
      {history.data?.occurrences.length === 0 && <p>No occurrences yet.</p>}
      <div className="flex gap-2">
        <Button variant="outline" disabled={!before} onClick={() => setBefore(undefined)}>
          Newest
        </Button>
        <Button
          variant="outline"
          disabled={!history.data?.next}
          onClick={() => setBefore(history.data!.next)}
        >
          Older
        </Button>
      </div>
    </section>
  );
}

function OccurrenceDetail({ id, onSession }: { id: string; onSession: (id: string) => void }) {
  const path = `/api/workflow-occurrences/${encodeURIComponent(id)}`;
  const resource = useWorkflowResource<{ occurrence: WorkflowOccurrence }>(path);
  const occurrence = resource.data?.occurrence;
  const view = useWorkflowResource<WorkflowExecutionView>(
    occurrence?.executionId ? `${path}/execution` : undefined,
  );
  const { error, busy, mutate } = useScheduleMutation();
  return (
    <section className="grid min-w-0 gap-3" aria-label="Scheduled occurrence">
      {(resource.error || view.error || error) && (
        <p role="alert" className="text-destructive">
          {resource.error || view.error || error}
        </p>
      )}
      <h2 className="text-lg font-semibold">
        {occurrence?.settings.name} · {occurrence?.status.replaceAll("-", " ")}
      </h2>
      {occurrence && (
        <>
          <p>
            Scheduled {new Date(occurrence.scheduledAt).toLocaleString()} · revision {occurrence.revision}
          </p>
          <p className="break-all text-sm">Scope: {occurrence.scope ?? occurrence.settings.projectId}</p>
          {occurrence.outcome && <p role="status">{occurrence.outcome}</p>}
          {occurrence.association === "failed" && (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void mutate(`${path}/retry-attachment`, "POST", {}, () => {})}
            >
              Retry Agent Session attachment
            </Button>
          )}
          {occurrence.association === "attached" && occurrence.sessionId && (
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => onSession(occurrence.sessionId!)}
            >
              Open Agent Session for input or recovery
            </Button>
          )}
          {["provisioning", "running", "recovery-required"].includes(occurrence.status) && (
            <>
              <p className="text-sm text-muted-foreground">
                Cancel stops work; it does not undo effects. Opening the Agent Session does not answer pending
                input.
              </p>
              <Button
                disabled={busy}
                className="justify-self-start"
                variant="destructive"
                onClick={() => void mutate(`${path}/cancel`, "POST", {}, () => {})}
              >
                Cancel occurrence
              </Button>
            </>
          )}
        </>
      )}
      {view.data && (
        <WorkflowExecutionInspector
          key={view.data.execution.id}
          view={view.data}
          detailBase={`${path}/execution`}
          transcriptBase={path}
        />
      )}
    </section>
  );
}
