import { useState } from "react";
import type { WorkflowRuntimeStatus } from "../../../src/protocol/workflow-executions.ts";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import "./workflows.css";
export default function SecretsSettings() {
  const { data, error } = useWorkflowResource<{ names: string[] }>(
    "/api/secrets",
  );
  const runtime = useWorkflowResource<WorkflowRuntimeStatus>(
    "/api/workflow-runtime",
  );
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMessage("Saved");
    } catch (e) {
      setMessage(String(e));
    }
  };
  return (
    <section className="workflows grid gap-4">
      <h1>Secrets</h1>
      <p>
        Values are write-only. References resolve when a step executes. Output
        redaction cannot prevent code from disclosing a secret.
      </p>
      <p role="status">{error || message}</p>
      <ul>
        {data?.names.map((n) => (
          <li key={n} className="flex gap-3">
            {n}
            <button
              onClick={() => {
                setName(n);
                setValue("");
              }}
            >
              Replace
            </button>
            <button
              onClick={() =>
                void act(() =>
                  workflowApi(
                    `/api/secrets/${encodeURIComponent(n)}`,
                    "DELETE",
                  ),
                )
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await workflowApi(
              `/api/secrets/${encodeURIComponent(name)}`,
              "PUT",
              { value },
            );
            setValue("");
          });
        }}
      >
        <label>
          Name
          <input
            autoComplete="off"
            required
            pattern="[A-Za-z_][A-Za-z0-9_-]*"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          New value
          <input
            type="password"
            autoComplete="new-password"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <button>Save secret</button>
      </form>
      <h2>Workflow runtime</h2>
      <p>
        External sandboxing applies only to Shell and TypeScript steps, not
        Agent steps. Disabled mode relies on the surrounding environment for
        operating-system isolation. TypeScript retains scoped filesystem checks.
        There is no automatic fallback.
      </p>
      <p role="status">
        {runtime.error ||
          (runtime.data
            ? runtime.data.available
              ? "Code runtime available"
              : (runtime.data.error ?? "Code runtime unavailable")
            : "Checking runtime")}
      </p>
      {runtime.data && (
        <form
          className="grid gap-3"
          key={`${runtime.data.externalSandbox}-${runtime.data.dockerImage}-${runtime.data.nodePath}-${runtime.data.dockerPath}`}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(() =>
              workflowApi("/api/config", "PUT", {
                workflowRuntime: {
                  externalSandbox: f.has("sandbox"),
                  dockerImage: f.get("image"),
                  nodePath: f.get("node"),
                  dockerPath: f.get("docker"),
                },
              }),
            );
          }}
        >
          <label>
            <input
              name="sandbox"
              type="checkbox"
              defaultChecked={runtime.data.externalSandbox}
            />
            External sandbox (default: enabled)
          </label>
          <label>
            Docker image
            <input
              name="image"
              defaultValue={runtime.data.dockerImage}
              required
            />
          </label>
          <label>
            Node executable override
            <input
              name="node"
              placeholder="Automatic PATH discovery"
              defaultValue={runtime.data.nodePath ?? ""}
            />
          </label>
          <label>
            Docker executable override
            <input
              name="docker"
              placeholder="Automatic PATH discovery"
              defaultValue={runtime.data.dockerPath ?? ""}
            />
          </label>
          <button>Save runtime settings</button>
        </form>
      )}
    </section>
  );
}
