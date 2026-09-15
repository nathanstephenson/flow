import { useRef, useState } from "react";
import { useHost } from "../host.tsx";
import { resolveDefaultBackend } from "../../../src/protocol/settings.ts";
import { workflowIssue, nextStepName } from "../presentation/workflows.ts";
import type {
  WorkflowDefinition,
  WorkflowStep,
  VisualSchema,
} from "../../../src/protocol/workflows.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { toTypeScript } from "../../../src/workflows/schema.ts";
import { useModelCatalogue } from "../models.ts";
import { WorkflowGraph } from "./workflow-graph.tsx";
import { SchemaEditor } from "./workflow-editors.tsx";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { ConditionEditor } from "./workflow-condition.tsx";
import { WorkflowCode } from "./workflow-code.tsx";
import { MappingEditor } from "./workflow-mapping.tsx";
import { StepTest } from "./workflow-test.tsx";
import { SettingsGroup } from "./settings-parts.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Textarea } from "./ui/textarea.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import "./workflows.css";
export default function WorkflowsSettings() {
  const list = useWorkflowResource<{ workflows: WorkflowDefinition[] }>(
    "/api/workflows",
  );
  const secrets = useWorkflowResource<{ names: string[] }>("/api/secrets");
  const { catalogue } = useModelCatalogue();
  const { config } = useHost();
  const mutation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [definition, setDefinition] = useState<WorkflowDefinition>();
  const [selected, select] = useState("");
  const [message, setMessage] = useState("");
  const [secretName, setSecretName] = useState("");
  const referenceSecret = secrets.data?.names.includes(secretName)
    ? secretName
    : (secrets.data?.names[0] ?? "");
  let invalid = "";
  let types = "";
  try {
    if (definition) {
      const graph = validateDefinition(definition);
      if (
        selected &&
        graph.inputSchemas.has(selected) &&
        graph.outputSchemas.has(selected)
      )
        types = `type Input = ${toTypeScript(graph.inputSchemas.get(selected)!)};\ntype Output = ${toTypeScript(graph.outputSchemas.get(selected)!)};\ntype Secrets = { ${Object.keys(
          definition.steps.find((s) => s.id === selected)?.secrets ?? {},
        )
          .map((k) => `${JSON.stringify(k)}: string`)
          .join("; ")} };`;
    }
  } catch (e) {
    invalid = workflowIssue(e);
  }
  const step = definition?.steps.find((s) => s.id === selected);
  const listing = catalogue?.find((b) => b.backend === definition?.backend);
  const selectedModel =
    step?.kind === "agent"
      ? listing?.models.find((m) => m.id === step.model)
      : undefined;
  const modelIssue =
    step?.kind === "agent"
      ? (listing?.problem ??
        (!listing?.models.length
          ? "Model catalogue unavailable. You can still edit and save definitions."
          : !selectedModel
            ? "Select an available model."
            : !selectedModel.effortLevels?.includes(step.effort)
              ? "The selected Effort is not listed for this model. The Session Host must confirm support before execution."
              : ""))
      : "";
  const update = (s: WorkflowStep) => {
    if (definition)
      setDefinition({
        ...definition,
        steps: definition.steps.map((old) => (old.id === s.id ? s : old)),
      });
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      await action();
      setMessage("Saved");
    } catch (e) {
      setMessage(workflowIssue(e));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const add = (kind: WorkflowStep["kind"]) => {
    if (!definition) return;
    const id = crypto.randomUUID();
    const base = { id, name: nextStepName(definition, kind) };
    const outputSchema: VisualSchema = { type: "object", fields: {} };
    const next: WorkflowStep =
      kind === "agent"
        ? {
            ...base,
            kind,
            instructions: "",
            model: "",
            effort: "medium",
            outputSchema,
          }
        : kind === "shell"
          ? { ...base, kind, command: "" }
          : kind === "typescript"
            ? { ...base, kind, code: "return {};", outputSchema }
            : kind === "branch"
              ? { ...base, kind, condition: { operator: "truthy", path: [] } }
              : { ...base, kind };
    setDefinition({ ...definition, steps: [...definition.steps, next] });
    select(id);
  };
  return (
    <SettingsGroup title="Workflows">
      <div className="workflow-editor text-sm">
        <div className="workflow-header">
          <Select
            value={definition?.id ?? ""}
            onValueChange={(value) => {
              setDefinition(list.data?.workflows.find((d) => d.id === value));
              select("");
            }}
          >
            <SelectTrigger
              aria-label="Workflow definition"
              className="w-full sm:max-w-sm"
            >
              <SelectValue>{definition?.name ?? "Select workflow"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Select workflow</SelectItem>
              {list.data?.workflows.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDefinition({
                version: 1,
                id: crypto.randomUUID(),
                name: "New workflow",
                backend:
                  resolveDefaultBackend(
                    config.backends,
                    config.providers?.defaultBackend,
                  ) ?? "",
                permission: "auto-accept",
                inputSchema: { type: "object", fields: {} },
                steps: [],
                edges: [],
              });
              select("");
            }}
          >
            New workflow
          </Button>
        </div>
        {(list.error || message) && (
          <p className="text-xs text-muted-foreground" role="status">
            {list.error || message}
          </p>
        )}
        {definition && (
          <>
            <div className="workflow-metadata">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Name</span>
                <Input
                  value={definition.name}
                  onChange={(e) =>
                    setDefinition({ ...definition, name: e.target.value })
                  }
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Backend Adapter</span>
                <Select
                  value={definition.backend}
                  onValueChange={(value) => {
                    if (value !== null)
                      setDefinition({ ...definition, backend: value });
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label="Backend Adapter"
                  >
                    <SelectValue>
                      {definition.backend || "Select backend"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {!config.backends.includes(definition.backend) && (
                      <SelectItem value={definition.backend}>
                        {definition.backend || "Select backend"}
                      </SelectItem>
                    )}
                    {config.backends.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Project</span>
                <Select
                  value={definition.projectId ?? ""}
                  onValueChange={(value) => {
                    const d = { ...definition };
                    if (value) d.projectId = value;
                    else delete d.projectId;
                    setDefinition(d);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Project">
                    <SelectValue>
                      {definition.projectId ?? "Machine-wide"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Machine-wide</SelectItem>
                    {definition.projectId &&
                      !config.projectList?.some(
                        (p) => p.path === definition.projectId,
                      ) && (
                        <SelectItem value={definition.projectId}>
                          {definition.projectId}
                        </SelectItem>
                      )}
                    {config.projectList?.map((p) => (
                      <SelectItem key={p.path} value={p.path}>
                        {p.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Permission</span>
                <Select
                  value={definition.permission ?? "auto-accept"}
                  onValueChange={(value) => {
                    if (value === "ask" || value === "auto-accept")
                      setDefinition({ ...definition, permission: value });
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label="Workflow permission"
                  >
                    <SelectValue>
                      {definition.permission === "ask" ? "Ask" : "Auto-accept"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto-accept">Auto-accept</SelectItem>
                    <SelectItem value="ask">Ask</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            <details className="workflow-input-schema rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Workflow input schema
              </summary>
              <p className="my-3 text-xs text-muted-foreground">
                Project restrictions include Worktrees. Auto-accept does not
                answer Enquiries. Steps share parent files.
              </p>
              <SchemaEditor
                root
                schema={definition.inputSchema}
                onChange={(s) =>
                  setDefinition({
                    ...definition,
                    inputSchema: s as WorkflowDefinition["inputSchema"],
                  })
                }
              />
            </details>
            <div className="workflow-toolbar">
              {(
                ["agent", "shell", "typescript", "branch", "join"] as const
              ).map((kind) => (
                <Button
                  size="sm"
                  variant="outline"
                  key={kind}
                  onClick={() => add(kind)}
                >
                  Add {kind === "typescript" ? "TypeScript" : kind}
                </Button>
              ))}
              <Button
                size="sm"
                disabled={!!invalid || busy}
                onClick={() =>
                  void perform(() =>
                    workflowApi(
                      `/api/workflows/${definition.id}`,
                      "PUT",
                      definition,
                    ),
                  )
                }
              >
                Save workflow
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await workflowApi(
                      `/api/workflows/${definition.id}`,
                      "DELETE",
                    );
                    setDefinition((current) =>
                      current?.id === definition.id ? undefined : current,
                    );
                  })
                }
              >
                Delete definition
              </Button>
            </div>
            {invalid && (
              <p className="text-xs text-destructive" role="alert">
                {invalid}
              </p>
            )}
            <div className="workflow-workspace">
              <WorkflowGraph
                definition={definition}
                onChange={setDefinition}
                onSelect={select}
              />
              {step && (
                <aside className="workflow-inspector grid gap-3 rounded-lg border p-4">
                  <h3 className="text-sm font-semibold">Selected step</h3>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Name</span>
                    <Input
                      value={step.name}
                      onChange={(e) =>
                        update({ ...step, name: e.target.value })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Permission</span>
                    <Select
                      value={step.permission ?? ""}
                      onValueChange={(value) => {
                        const s = { ...step };
                        if (value === "ask" || value === "auto-accept")
                          s.permission = value;
                        else delete s.permission;
                        update(s);
                      }}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label="Step permission"
                      >
                        <SelectValue>
                          {step.permission
                            ? step.permission === "ask"
                              ? "Ask"
                              : "Auto-accept"
                            : `Inherit (${definition.permission ?? "auto-accept"})`}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">
                          Inherit ({definition.permission ?? "auto-accept"})
                        </SelectItem>
                        <SelectItem value="ask">Ask</SelectItem>
                        <SelectItem value="auto-accept">Auto-accept</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">
                      Timeout override (milliseconds)
                    </span>
                    <Input
                      type="number"
                      min="1"
                      value={step.timeoutMs ?? ""}
                      onChange={(e) => {
                        const s = { ...step };
                        if (e.target.value)
                          s.timeoutMs = Number(e.target.value);
                        else delete s.timeoutMs;
                        update(s);
                      }}
                    />
                  </label>
                  {step.kind === "agent" && (
                    <>
                      {modelIssue && (
                        <p
                          className="text-xs text-muted-foreground"
                          role="status"
                        >
                          {modelIssue}
                        </p>
                      )}
                      <div className="flex flex-col gap-1">
                        <span className="text-sm font-medium">Model</span>
                        <ModelPicker
                          models={[
                            ...(!selectedModel
                              ? [
                                  {
                                    id: step.model,
                                    label: step.model || "Select model",
                                  },
                                ]
                              : []),
                            ...(listing?.models ?? []),
                          ]}
                          model={
                            selectedModel ?? {
                              id: step.model,
                              label: step.model || "Select model",
                            }
                          }
                          onSelect={(model) => update({ ...step, model })}
                        />
                      </div>
                      <label className="flex flex-col gap-1">
                        <span className="text-sm font-medium">Effort</span>
                        <Select
                          value={step.effort}
                          onValueChange={(value) => {
                            if (value !== null)
                              update({
                                ...step,
                                effort: value as typeof step.effort,
                              });
                          }}
                        >
                          <SelectTrigger className="w-full" aria-label="Effort">
                            <SelectValue>{step.effort}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={step.effort}>
                              {step.effort}
                            </SelectItem>
                            {selectedModel?.effortLevels
                              ?.filter((v) => v !== step.effort)
                              .map((v) => (
                                <SelectItem key={v} value={v}>
                                  {v}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-sm font-medium">
                          Instructions
                        </span>
                        <Textarea
                          value={step.instructions}
                          onChange={(e) =>
                            update({ ...step, instructions: e.target.value })
                          }
                        />
                      </label>
                    </>
                  )}
                  {step.kind === "shell" && (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className="text-sm font-medium">
                          Shell command
                        </span>
                        <Textarea
                          className="font-mono"
                          spellCheck={false}
                          value={step.command}
                          onChange={(e) =>
                            update({ ...step, command: e.target.value })
                          }
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Input is JSON in $OUTPUT. Default timeout: 60 seconds.
                      </p>
                      <label className="flex flex-col gap-1">
                        <span className="text-sm font-medium">
                          Accepted exit codes (comma separated)
                        </span>
                        <Input
                          value={(step.acceptedExitCodes ?? [0]).join(",")}
                          onChange={(e) =>
                            update({
                              ...step,
                              acceptedExitCodes: e.target.value
                                .split(",")
                                .map(Number),
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  {step.kind === "typescript" && (
                    <>
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                        {types ||
                          "Correct graph errors to generate input and output types."}
                      </pre>
                      <WorkflowCode
                        key={step.id}
                        value={step.code}
                        onChange={(code) => update({ ...step, code })}
                      />
                      <p className="text-xs text-muted-foreground">
                        Available: input, secrets, fs, fetch. No imports or
                        process access. Default timeout: 60 seconds.
                      </p>
                    </>
                  )}
                  {"outputSchema" in step && (
                    <SchemaEditor
                      schema={step.outputSchema}
                      onChange={(outputSchema) =>
                        update({ ...step, outputSchema })
                      }
                    />
                  )}
                  {step.kind === "branch" && (
                    <ConditionEditor
                      definition={definition}
                      step={step}
                      onChange={update}
                    />
                  )}
                  {step.kind !== "join" && (
                    <MappingEditor
                      definition={definition}
                      step={step}
                      onChange={update}
                    />
                  )}
                  <StepTest
                    key={step.id}
                    definition={definition}
                    stepId={step.id}
                  />
                  <fieldset className="grid gap-3 rounded-lg border p-3">
                    <legend className="px-1 text-sm font-medium">
                      Secret references
                    </legend>
                    {Object.entries(step.secrets ?? {}).map(([alias, name]) => (
                      <div key={alias} className="grid gap-2">
                        <span className="text-sm font-medium">{alias}</span>
                        <Select
                          value={name}
                          onValueChange={(value) => {
                            if (value !== null)
                              update({
                                ...step,
                                secrets: { ...step.secrets, [alias]: value },
                              });
                          }}
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={`${alias} secret`}
                          >
                            <SelectValue>{name}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={name}>{name}</SelectItem>
                            {secrets.data?.names
                              .filter((n) => n !== name)
                              .map((n) => (
                                <SelectItem key={n} value={n}>
                                  {n}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="justify-self-start"
                          onClick={() =>
                            update({
                              ...step,
                              secrets: Object.fromEntries(
                                Object.entries(step.secrets ?? {}).filter(
                                  ([k]) => k !== alias,
                                ),
                              ),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <form
                      className="grid gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = e.currentTarget;
                        const data = new FormData(f);
                        update({
                          ...step,
                          secrets: {
                            ...step.secrets,
                            [String(data.get("alias"))]: String(
                              data.get("secret"),
                            ),
                          },
                        });
                        f.reset();
                        setSecretName("");
                      }}
                    >
                      <Input
                        name="alias"
                        aria-label="Secret alias"
                        placeholder="Secret alias"
                        required
                      />
                      <Select
                        name="secret"
                        value={referenceSecret || null}
                        onValueChange={(value) => setSecretName(value ?? "")}
                        required
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="Named secret"
                        >
                          <SelectValue>
                            {referenceSecret || "Select secret"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {secrets.data?.names.map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                      >
                        Add reference
                      </Button>
                    </form>
                  </fieldset>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="justify-self-start"
                    onClick={() => {
                      setDefinition({
                        ...definition,
                        steps: definition.steps.filter((s) => s.id !== step.id),
                        edges: definition.edges.filter(
                          (e) => e.from !== step.id && e.to !== step.id,
                        ),
                      });
                      select("");
                    }}
                  >
                    Delete step
                  </Button>
                </aside>
              )}
              {!step && (
                <aside className="workflow-inspector rounded-lg border p-4 text-sm text-muted-foreground">
                  Select a step to edit its settings.
                </aside>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsGroup>
  );
}
