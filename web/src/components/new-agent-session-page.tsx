import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { IncomingAttachment } from "../../../src/protocol/attachments.ts";
import type { Capabilities, EffortLevel } from "../../../src/protocol/events.ts";
import type { Project } from "../../../src/protocol/projects.ts";
import { resolveDefaultBackend } from "../../../src/protocol/settings.ts";
import type { WorkflowExecutionView, WorkflowRuntimeStatus } from "../../../src/protocol/workflow-executions.ts";
import type { Json, WorkflowDefinition } from "../../../src/protocol/workflows.ts";
import { useCommand } from "@/agent-sessions.tsx";
import { useBranches } from "@/branches.ts";
import type { ComposerActions } from "@/composer-actions.ts";
import { NEW_AGENT_SESSION_DRAFT, type DraftStash } from "@/drafts.ts";
import { useHost } from "@/host.tsx";
import { useModelCatalogue } from "@/models.ts";
import { useScopeSkills } from "@/skills.ts";
import { preselectedModel } from "@/presentation/default-model.ts";
import {
  createCommandFor,
  eligibleWorkflows,
  validatedWorkflowInput,
  validatedWorkflowInputSchema,
} from "@/presentation/new-agent-session.ts";
import { groupProjects, type ProjectGroup } from "@/presentation/projects.ts";
import { workflowIssue } from "@/presentation/workflows.ts";
import { retainWorkflowLaunch } from "@/workflow-launch.ts";
import { Composer } from "@/components/composer.tsx";
import { initialValue, ValueEditor } from "@/components/workflow-editors.tsx";
import { workflowApi, useWorkflowResource } from "@/components/workflow-api.ts";
import { TurnStrip } from "@/components/turn-strip.tsx";
import type { Chrome } from "@/store/contract.ts";
import { Button } from "@/components/ui/button.tsx";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { QUIET_TRIGGER } from "@/lib/quiet-trigger.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Create an Agent Session for ordinary chat or launch a full Workflow Execution into one.
 *
 * Scope and runtime choices live above/below the tab panels, so switching tabs cannot produce two
 * disagreeing launch forms. The Chat Draft is still owned by `Composer`; the workflow draft stays in
 * this mounted page and deliberately disappears on ordinary navigation.
 */
export function NewAgentSessionPage({
  initialBackend,
  drafts,
  onCreated,
}: {
  initialBackend?: string;
  drafts: DraftStash;
  onCreated: (sessionId: string, openWorkflows?: boolean) => void;
}) {
  const { config, refresh } = useHost();
  const run = useCommand();
  const [tab, setTab] = useState<"chat" | "workflow">("chat");
  const [mcpChoices, setMcpChoices] = useState<Record<string, boolean>>({});
  const mcpConnectionIds = (config.mcp ?? [])
    .filter((connection) => mcpChoices[connection.id] ?? connection.enabledByDefault)
    .map((connection) => connection.id);
  const projects = config.projectList ?? [];
  const uncurated = (config.projectCandidates ?? []).length;

  const [projectPath, setProjectPath] = useState<string | undefined>(() => drafts.scope());
  const project = projects.find((candidate) => candidate.path === projectPath);
  const scope = project?.path;
  const [chosenBackend, setBackend] = useState<string | undefined>(initialBackend);
  const backend = chosenBackend ?? resolveDefaultBackend(config.backends, config.providers?.defaultBackend) ?? "";
  const [chosenModel, setChosenModel] = useState<string | undefined>();
  const [effort, setEffort] = useState<EffortLevel | undefined>();
  const [inWorktree, setInWorktree] = useState(false);
  const [cutFrom, setCutFrom] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const projectField = useRef<HTMLLabelElement | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const branches = useBranches(scope);
  useEffect(() => {
    if (config.git !== false) branches.load();
  }, [scope, config.git]);
  const listSkills = useScopeSkills(scope, backend);
  const repository = branches.list?.repository === true;
  const head = branches.list?.head;
  const checkedOut = head?.detached ? undefined : head?.name;
  const base = cutFrom ?? checkedOut ?? "";

  const { catalogue: models, loading: modelsLoading, problem: modelsProblem, refresh: refreshModels } = useModelCatalogue();
  const backendModels = models?.find((entry) => entry.backend === backend);
  const model =
    backendModels?.models.find((candidate) => candidate.id === chosenModel) ??
    preselectedModel(models, config.providers?.defaults, backend);
  const discoveryProblem = modelsLoading
    ? "Checking model capabilities before starting agent work…"
    : modelsProblem ?? backendModels?.problem
      ?? (!backendModels ? `Model capabilities for ${backend || "this backend"} are unavailable.`
        : !model ? `No confirmed model is available for ${backend}.` : undefined);
  const savedDefaultEffort = config.providers?.efforts?.[backend];
  const defaultLevels = model?.effortLevels ?? [];
  const invalidSavedDefault = effort === undefined && savedDefaultEffort !== undefined && !!model
    && (defaultLevels.length > 0 ? !defaultLevels.includes(savedDefaultEffort) : savedDefaultEffort !== "off");
  const defaultEffortProblem = invalidSavedDefault
    ? defaultLevels.length > 0
      ? `Saved Default Effort “${savedDefaultEffort}” is unsupported for ${model?.label ?? model?.id}. Select a supported Effort here or correct Provider Settings.`
      : `Saved Default Effort “${savedDefaultEffort}” is invalid because ${model?.label ?? model?.id} has no Effort control. Clear it in Provider Settings.`
    : undefined;
  const capabilityProblem = discoveryProblem ?? defaultEffortProblem;
  const command = createCommandFor({
    scope: scope ?? "",
    backend,
    modelId: model?.id,
    effort,
    inWorktree,
    repository,
    base,
  });
  const shownBranch = inWorktree ? (base === "" ? undefined : { name: base }) : head;

  const chrome = useMemo<Chrome>(
    () => ({
      status: "idle",
      backend,
      scope,
      capabilities: backendModels && !discoveryProblem
        ? ({
            providers: [],
            models: backendModels.models,
            compaction: false,
            fork: false,
            subagents: false,
            enquiries: false,
            permissions: false,
          } satisfies Capabilities)
        : undefined,
      model,
      effort,
      branch: shownBranch,
      worktree: undefined,
      contextUsage: undefined,
      endedReason: undefined,
      queueDepth: 0,
      activeSubagents: 0,
      activeBackgroundCalls: 0,
      asking: undefined,
      authorising: undefined,
      compacting: false,
      spoken: false,
      link: "live",
    }),
    [backend, backendModels, discoveryProblem, effort, model, scope, shownBranch],
  );

  const create = useCallback(async (): Promise<string | undefined> => {
    if (!command) return;
    setFailure(undefined);
    const created = await run<string>({ ...command, mcpConnectionIds });
    if (!created) setFailure("The Session Host refused this. Check the Project and branch to cut from.");
    return created;
  }, [command, mcpConnectionIds, run]);

  const send = useCallback(
    async (text: string, attachments: IncomingAttachment[]): Promise<unknown | undefined> => {
      const created = await create();
      if (!created) return;
      const queued =
        text === "" && attachments.length === 0
          ? true
          : await run<{ queued?: boolean }>({
              type: "send",
              sessionId: created,
              text,
              ...(attachments.length ? { attachments } : {}),
              when: "after_turn",
            });
      drafts.write(NEW_AGENT_SESSION_DRAFT, { text: "", attachments: [] });
      onCreated(created);
      return queued;
    },
    [create, drafts, onCreated, run],
  );

  const actions = useMemo<ComposerActions>(
    () => ({
      send,
      setModel: (modelId) => {
        setChosenModel(modelId);
        const levels = backendModels?.models.find((candidate) => candidate.id === modelId)?.effortLevels ?? [];
        setEffort((current) => current && levels.includes(current) ? current : undefined);
      },
      setEffort,
      switchBranch: async (branch: string) => {
        if (inWorktree) {
          setCutFrom(branch);
          return true;
        }
        if (!scope) return false;
        const moved = await run({ type: "switch_scope_branch", scope, branch });
        if (moved !== undefined) branches.load();
        return moved !== undefined;
      },
      listSkills,
    }),
    [backendModels, branches, inWorktree, listSkills, run, scope, send],
  );

  const definitions = useWorkflowResource<{ workflows: WorkflowDefinition[] }>(tab === "workflow" ? "/api/workflows" : undefined, 10_000);
  const availableWorkflows = useMemo(
    () => eligibleWorkflows(definitions.data?.workflows ?? [], backend, projectPath),
    [backend, definitions.data, projectPath],
  );
  const [workflowId, setWorkflowId] = useState("");
  const [workflowInput, setWorkflowInput] = useState<Json>({});
  const workflow = availableWorkflows.find((definition) => definition.id === workflowId);
  const workflowValidation = useMemo(() => {
    if (!workflow) return {};
    try {
      return { schema: validatedWorkflowInputSchema(workflow) };
    } catch (error) {
      return { issue: workflowIssue(error) };
    }
  }, [workflow]);

  useEffect(() => {
    if (workflowId && !availableWorkflows.some((definition) => definition.id === workflowId)) {
      setWorkflowId("");
      setWorkflowInput({});
    }
  }, [availableWorkflows, workflowId]);

  let validatedInput: Json | undefined;
  let inputIssue = "";
  if (workflowValidation.issue) {
    inputIssue = workflowValidation.issue;
  } else if (workflowValidation.schema) {
    try {
      validatedInput = validatedWorkflowInput(workflowValidation.schema, workflowInput);
    } catch (error) {
      inputIssue = workflowIssue(error);
    }
  }
  const needsCodeRuntime = workflow?.steps.some((step) => step.kind === "shell" || step.kind === "typescript") === true;
  const runtime = useWorkflowResource<WorkflowRuntimeStatus>(tab === "workflow" && needsCodeRuntime ? "/api/workflow-runtime" : undefined, 5_000);
  const runtimeIssue = needsCodeRuntime
    ? runtime.error || (runtime.data === undefined ? "Checking workflow runtime…" : runtime.data.available ? "" : runtime.data.error ?? "Workflow runtime is unavailable")
    : "";
  const [launching, setLaunching] = useState(false);
  const launchInFlight = useRef(false);

  const launchWorkflow = useCallback(async () => {
    if (launchInFlight.current || !workflow || validatedInput === undefined || inputIssue || runtimeIssue) return;
    launchInFlight.current = true;
    setLaunching(true);
    setFailure(undefined);
    const input = validatedInput;
    const launchId = crypto.randomUUID();
    try {
      const created = await create();
      if (!created) return;
      try {
        await workflowApi<WorkflowExecutionView>(
          `/api/sessions/${encodeURIComponent(created)}/workflows`,
          "POST",
          { workflowId: workflow.id, input, launchId, nameSession: true },
        );
      } catch (error) {
        retainWorkflowLaunch(created, {
          launchId,
          workflowId: workflow.id,
          input,
          error: workflowIssue(error),
        });
      }
      // Success opens monitoring; partial failure opens the same surface with a preserved retry.
      onCreated(created, true);
    } finally {
      launchInFlight.current = false;
      setLaunching(false);
    }
  }, [create, inputIssue, onCreated, runtimeIssue, validatedInput, workflow]);

  useEffect(() => {
    if (scope === undefined) projectField.current?.querySelector("button")?.focus();
    else document.querySelector<HTMLElement>("[data-new-session] [data-composer-input]")?.focus();
  }, []);
  useEffect(
    () => () => {
      if (projectPath !== undefined) drafts.setScope(projectPath);
    },
    [drafts, projectPath],
  );

  const groups = groupProjects(projects);

  return (
    <div data-new-session="" className="transcript-scroller min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-12 sm:px-6">
        <h1 className="text-center text-lg font-medium">New Agent Session</h1>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (value === "chat" || value === "workflow") setTab(value);
          }}
          className="contents"
        >
          <TabsList aria-label="New Agent Session mode" className="mx-auto">
            {(["chat", "workflow"] as const).map((mode) => (
              <TabsTrigger key={mode} value={mode} className="min-w-24 capitalize">
                {mode}
              </TabsTrigger>
            ))}
          </TabsList>

          {projects.length === 0 ? (
            <>
              <TabsContent value="chat">
                <NoProjects uncurated={uncurated} />
              </TabsContent>
              <TabsContent value="workflow">
                <NoProjects uncurated={uncurated} />
              </TabsContent>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center gap-2">
                <Select
                  value={backend}
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    setBackend(value);
                    setChosenModel(undefined);
                    setEffort(undefined);
                  }}
                >
                  <SelectTrigger aria-label="Backend" size="sm" className={cn(QUIET_TRIGGER, "w-auto")}>
                    <SelectValue>{() => backend}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {config.backends.map((name) => (
                      <SelectItem key={name} value={name}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ProjectPicker
                  fieldRef={projectField}
                  groups={groups}
                  projects={projects}
                  project={project}
                  onPick={(picked) => {
                    setProjectPath(picked.path);
                    setCutFrom(undefined);
                    setInWorktree(false);
                  }}
                />
              </div>

              {capabilityProblem ? (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
                  <span>{capabilityProblem}</span>
                  {!modelsLoading && discoveryProblem ? (
                    <Button size="sm" variant="ghost" onClick={() => void refreshModels()}>Check again</Button>
                  ) : null}
                </div>
              ) : null}
              <TabsContent value="chat" keepMounted className="grid gap-3">
                <Composer
                  id={NEW_AGENT_SESSION_DRAFT}
                  chrome={chrome}
                  actions={actions}
                  floating={false}
                  unavailable={backend === "" ? "This Session Host advertises no backend" : capabilityProblem}
                  placeholder="What should it work on? Enter starts the Agent Session."
                  drafts={drafts}
                  authorisingSummary={undefined}
                  onShowSubagents={() => {}}
                />
              </TabsContent>
              <TabsContent value="workflow" keepMounted className="grid gap-4 rounded-xl border bg-card/30 p-4">
                <div>
                  <h2 className="font-medium">Start with a workflow</h2>
                  <p className="text-xs text-muted-foreground">
                    The workflow runs independently, so the parent chat stays available for questions and follow-up work.
                  </p>
                </div>
                {definitions.error ? (
                  <p role="alert" className="text-sm text-destructive">Could not load workflows: {definitions.error}</p>
                ) : definitions.data === undefined ? (
                  <p className="text-sm text-muted-foreground">Loading compatible workflows…</p>
                ) : availableWorkflows.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No global or {project?.name} workflows use Backend Adapter {backend}.
                  </p>
                ) : (
                  <>
                    <label className="grid gap-1.5">
                      <span className="text-sm font-medium">Workflow</span>
                      <Select
                        value={workflowId}
                        onValueChange={(value) => {
                          if (value === null) return;
                          const selected = availableWorkflows.find((definition) => definition.id === value);
                          setWorkflowId(value);
                          setWorkflowInput(selected ? initialValue(selected.inputSchema) : {});
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label="Workflow">
                          <SelectValue>{workflow?.name ?? "Select a workflow"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">Select a workflow</SelectItem>
                          {availableWorkflows.map((definition) => (
                            <SelectItem key={definition.id} value={definition.id}>
                              {definition.name}{definition.projectId === undefined ? " · Global" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    {workflow ? (
                      <div className="grid gap-4">
                        <fieldset className="grid gap-3 rounded-lg border p-3">
                          <legend className="px-1 text-sm font-medium">Inputs</legend>
                          <ValueEditor schema={workflow.inputSchema} value={workflowInput} onChange={setWorkflowInput} />
                        </fieldset>
                        {(inputIssue || runtimeIssue) && (
                          <p role="alert" className="text-xs text-destructive">{inputIssue || runtimeIssue}</p>
                        )}
                        <Button
                          className="justify-self-start"
                          disabled={launching || !command || validatedInput === undefined || !!inputIssue || !!runtimeIssue || !!capabilityProblem}
                          onClick={() => void launchWorkflow()}
                        >
                          {launching ? "Starting workflow…" : "Create Agent Session and start"}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
                <div className="overflow-hidden rounded-xl border bg-background">
                  <TurnStrip chrome={chrome} actions={actions} />
                </div>
              </TabsContent>

              {(config.mcp ?? []).length > 0 && (
                <Accordion>
                  <AccordionItem value="mcp">
                    <AccordionTrigger>
                      MCP connections
                      <Badge variant="secondary" aria-label={`${mcpConnectionIds.length} enabled`}>{mcpConnectionIds.length}</Badge>
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-3">
                      {config.mcp!.map((connection) => (
                        <label key={connection.id} className="flex items-center justify-between gap-3 text-sm">
                          {connection.name}
                          <Switch
                            checked={mcpChoices[connection.id] ?? connection.enabledByDefault}
                            onCheckedChange={(checked) => setMcpChoices((choices) => ({ ...choices, [connection.id]: checked }))}
                          />
                        </label>
                      ))}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              {repository && config.git !== false ? (
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={inWorktree}
                      onChange={(event) => setInWorktree(event.target.checked)}
                    />
                    <span className="text-sm font-medium">Start in a new worktree</span>
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {inWorktree ? (
                      <>The branch above is what it will be cut from; a name is chosen for you. The worktree is kept by the Session Host and removed when this Agent Session is reaped, but only if nothing is uncommitted.</>
                    ) : (
                      <>This Agent Session shares {project?.name ?? "the Project"}&rsquo;s checkout, so choosing a branch above moves it — for anything else already working there too. A worktree gives this one its own.</>
                    )}
                  </span>
                </div>
              ) : null}
              {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
            </>
          )}
        </Tabs>
      </div>
    </div>
  );
}

function ProjectPicker({
  fieldRef,
  groups,
  projects,
  project,
  onPick,
}: {
  fieldRef: RefObject<HTMLLabelElement | null>;
  groups: ProjectGroup[];
  projects: Project[];
  project: Project | undefined;
  onPick: (project: Project) => void;
}) {
  return (
    <label ref={fieldRef} className="flex">
      <Combobox
        items={groups}
        value={project ?? null}
        isItemEqualToValue={(left: Project, right: Project) => left.path === right.path}
        itemToStringLabel={projectLabel}
        itemToStringValue={(candidate: Project) => candidate.path}
        onValueChange={(value) => {
          const picked = value as Project | null;
          if (picked) onPick(picked);
        }}
      >
        <ComboboxTrigger aria-label="Project" render={<Button variant="ghost" size="sm" className={cn(QUIET_TRIGGER, "w-auto")} />}>
          <ComboboxValue>
            {(picked: Project | null) => picked === null
              ? <span className="text-muted-foreground">Choose a Project</span>
              : <span className="font-mono text-xs">{projectLabel(picked)}</span>}
          </ComboboxValue>
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput showTrigger={false} placeholder={`Filter ${projects.length} ${projects.length === 1 ? "Project" : "Projects"}`} />
          <ComboboxList>
            {(group: ProjectGroup) => (
              <ComboboxGroup key={group.group ?? ""} items={group.items}>
                {group.group === undefined ? null : <ComboboxLabel>{group.group}</ComboboxLabel>}
                <ComboboxCollection>
                  {(candidate: Project) => (
                    <ComboboxItem key={candidate.path} value={candidate}>
                      <span className="font-mono text-xs">{candidate.name}</span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
          <ComboboxEmpty>No Project matches.</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
    </label>
  );
}

function NoProjects({ uncurated }: { uncurated: number }) {
  return (
    <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      No Projects yet. {uncurated > 0 ? (
        <>{uncurated} {uncurated === 1 ? "repository was" : "repositories were"} found beneath the Project Root — opt in under Settings → Projects to start an Agent Session in one.</>
      ) : (
        <>Add one under Settings → Projects to start an Agent Session in it.</>
      )}
    </p>
  );
}

function projectLabel(project: Project): string {
  return project.group === undefined ? project.name : `${project.group}/${project.name}`;
}
