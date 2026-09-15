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
  let invalid = "";
  let types = "";
  try {
    if (definition) {
      const graph = validateDefinition(definition);
      if (selected && graph.inputSchemas.has(selected) && graph.outputSchemas.has(selected))
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
    <section className="workflows workflow-editor">
      <div className="workflow-header">
      <h1>Workflows</h1>
        <select
          aria-label="Workflow definition"
          value={definition?.id ?? ""}
          onChange={(e) => {
            setDefinition(
              list.data?.workflows.find((d) => d.id === e.target.value),
            );
            select("");
          }}
        >
          <option value="">Select workflow</option>
          {list.data?.workflows.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setDefinition({
              version: 1,
              id: crypto.randomUUID(),
              name: "New workflow",
              backend: resolveDefaultBackend(config.backends, config.providers?.defaultBackend) ?? "",
              permission: "auto-accept",
              inputSchema: { type: "object", fields: {} },
              steps: [],
              edges: [],
            });
            select("");
          }}
        >
          New workflow
        </button>
      </div>
      <p role="status">{list.error || message}</p>
      {definition && (
        <>
          <div className="workflow-metadata">
            <label>
              Name
              <input
                value={definition.name}
                onChange={(e) =>
                  setDefinition({ ...definition, name: e.target.value })
                }
              />
            </label>
            <label>
              Backend Adapter
              <select
                value={definition.backend}
                onChange={(e) =>
                  setDefinition({ ...definition, backend: e.target.value })
                }
              >
                {!config.backends.includes(definition.backend) && <option value={definition.backend}>{definition.backend || "Select backend"}</option>}
                {config.backends.map((b) => <option key={b}>{b}</option>)}
              </select>
            </label>
            <label>
              Project
              <select
                value={definition.projectId ?? ""}
                onChange={(e) => {
                  const d = { ...definition };
                  if (e.target.value) d.projectId = e.target.value;
                  else delete d.projectId;
                  setDefinition(d);
                }}
              >
                <option value="">Machine-wide</option>
                {definition.projectId && !config.projectList?.some((p) => p.path === definition.projectId) && <option>{definition.projectId}</option>}
                {config.projectList?.map((p) => <option key={p.path} value={p.path}>{p.path}</option>)}
              </select>
            </label>
            <label>
              Permission
              <select
                value={definition.permission ?? "auto-accept"}
                onChange={(e) =>
                  setDefinition({
                    ...definition,
                    permission: e.target.value as "ask" | "auto-accept",
                  })
                }
              >
                <option value="auto-accept">Auto-accept</option>
                <option value="ask">Ask</option>
              </select>
            </label>
          </div>
          <details className="workflow-input-schema"><summary>Workflow input schema</summary>
          <p>Project restrictions include Worktrees. Auto-accept does not answer Enquiries. Steps share parent files.</p>
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
            {(["agent", "shell", "typescript", "branch", "join"] as const).map(
              (kind) => (
                <button key={kind} onClick={() => add(kind)}>
                  Add {kind}
                </button>
              ),
            )}
            <button disabled={!!invalid || busy} onClick={() => void perform(() => workflowApi(`/api/workflows/${definition.id}`, "PUT", definition))}>Save workflow</button>
            <button disabled={busy} onClick={() => void perform(async () => {
              await workflowApi(`/api/workflows/${definition.id}`, "DELETE");
              setDefinition((current) => current?.id === definition.id ? undefined : current);
            })}>Delete definition</button>
          </div>
          {invalid && <p role="alert">{invalid}</p>}
          <div className="workflow-workspace">
          <WorkflowGraph
            definition={definition}
            onChange={setDefinition}
            onSelect={select}
          />
          {step && (
            <aside className="workflow-inspector grid gap-3 border p-4">
              <h2>Selected step</h2>
              <label>
                Name
                <input
                  value={step.name}
                  onChange={(e) => update({ ...step, name: e.target.value })}
                />
              </label>
              <label>
                Permission
                <select
                  value={step.permission ?? ""}
                  onChange={(e) => {
                    const s = { ...step };
                    if (e.target.value)
                      s.permission = e.target.value as "ask" | "auto-accept";
                    else delete s.permission;
                    update(s);
                  }}
                >
                  <option value="">
                    Inherit ({definition.permission ?? "auto-accept"})
                  </option>
                  <option value="ask">Ask</option>
                  <option value="auto-accept">Auto-accept</option>
                </select>
              </label>
              <label>
                Timeout override (milliseconds)
                <input
                  type="number"
                  min="1"
                  value={step.timeoutMs ?? ""}
                  onChange={(e) => {
                    const s = { ...step };
                    if (e.target.value) s.timeoutMs = Number(e.target.value);
                    else delete s.timeoutMs;
                    update(s);
                  }}
                />
              </label>
              {step.kind === "agent" && (
                <>
                  <p role="status">{modelIssue}</p>
                  <label>
                    Model
                    <select
                      value={step.model}
                      onChange={(e) =>
                        update({ ...step, model: e.target.value })
                      }
                    >
                      <option value={step.model}>
                        {step.model || "Select model"}
                      </option>
                      {catalogue
                        ?.find((b) => b.backend === definition.backend)
                        ?.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label ?? m.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Effort
                    <select
                      value={step.effort}
                      onChange={(e) =>
                        update({
                          ...step,
                          effort: e.target.value as typeof step.effort,
                        })
                      }
                    >
                      <option value={step.effort}>{step.effort}</option>
                      {catalogue
                        ?.find((b) => b.backend === definition.backend)
                        ?.models.find((m) => m.id === step.model)
                        ?.effortLevels?.filter((v) => v !== step.effort)
                        .map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Instructions
                    <textarea
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
                  <label>
                    Shell command
                    <textarea
                      spellCheck={false}
                      value={step.command}
                      onChange={(e) =>
                        update({ ...step, command: e.target.value })
                      }
                    />
                  </label>
                  <p>Input is JSON in $OUTPUT. Default timeout: 60 seconds.</p>
                  <label>
                    Accepted exit codes (comma separated)
                    <input
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
                  <pre>
                    {types ||
                      "Correct graph errors to generate input and output types."}
                  </pre>
                  <WorkflowCode
                    key={step.id}
                    value={step.code}
                    onChange={(code) => update({ ...step, code })}
                  />
                  <p>
                    Available: input, secrets, fs, fetch. No imports or process
                    access. Default timeout: 60 seconds.
                  </p>
                </>
              )}
              {"outputSchema" in step && (
                <SchemaEditor
                  schema={step.outputSchema}
                  onChange={(outputSchema) => update({ ...step, outputSchema })}
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
              <fieldset>
                <legend>Secret references</legend>
                {Object.entries(step.secrets ?? {}).map(([alias, name]) => (
                  <div key={alias}>
                    {alias}
                    <select
                      value={name}
                      onChange={(e) =>
                        update({
                          ...step,
                          secrets: { ...step.secrets, [alias]: e.target.value },
                        })
                      }
                    >
                      <option value={name}>{name}</option>
                      {secrets.data?.names
                        .filter((n) => n !== name)
                        .map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                    </select>
                    <button
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
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = e.currentTarget;
                    const data = new FormData(f);
                    update({
                      ...step,
                      secrets: {
                        ...step.secrets,
                        [String(data.get("alias"))]: String(data.get("secret")),
                      },
                    });
                    f.reset();
                  }}
                >
                  <input name="alias" aria-label="Secret alias" required />
                  <select name="secret" aria-label="Named secret" required>
                    {secrets.data?.names.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                  <button>Add reference</button>
                </form>
              </fieldset>
              <button
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
              </button>
            </aside>
          )}
          {!step && <aside className="workflow-inspector">Select a step to edit its settings.</aside>}
          </div>
        </>
      )}
    </section>
  );
}
