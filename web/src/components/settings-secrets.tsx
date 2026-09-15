import { useState } from "react";
import type { WorkflowRuntimeStatus } from "../../../src/protocol/workflow-executions.ts";
import { workflowApi, useWorkflowResource } from "./workflow-api.ts";
import { SettingsGroup } from "./settings-parts.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Switch } from "./ui/switch.tsx";
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
    <>
      <SettingsGroup
        title="Secrets"
        description="Values are write-only. References resolve when a step executes. Output redaction cannot prevent code from disclosing a secret."
      >
        {(error || message) && (
          <p className="text-xs text-muted-foreground" role="status">
            {error || message}
          </p>
        )}
        <ul className="divide-y">
          {data?.names.map((n) => (
            <li key={n} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {n}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setName(n);
                  setValue("");
                }}
              >
                Replace
              </Button>
              <Button
                size="sm"
                variant="destructive"
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
              </Button>
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
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Name</span>
            <Input
              autoComplete="off"
              required
              pattern="[A-Za-z_][A-Za-z0-9_-]*"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">New value</span>
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" className="justify-self-start">
            Save secret
          </Button>
        </form>
      </SettingsGroup>
      <SettingsGroup
        title="Workflow runtime"
        description="External sandboxing applies only to Shell and TypeScript steps, not Agent steps. Disabled mode relies on the surrounding environment for operating-system isolation. TypeScript retains scoped filesystem checks. There is no automatic fallback."
      >
        <p className="text-xs text-muted-foreground" role="status">
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
            <label className="flex items-center justify-between gap-4">
              <span className="text-sm">
                External sandbox (default: enabled)
              </span>
              <Switch
                name="sandbox"
                defaultChecked={runtime.data.externalSandbox}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Docker image</span>
              <Input
                name="image"
                defaultValue={runtime.data.dockerImage}
                required
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">
                Node executable override
              </span>
              <Input
                name="node"
                placeholder="Automatic PATH discovery"
                defaultValue={runtime.data.nodePath ?? ""}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">
                Docker executable override
              </span>
              <Input
                name="docker"
                placeholder="Automatic PATH discovery"
                defaultValue={runtime.data.dockerPath ?? ""}
              />
            </label>
            <Button type="submit" size="sm" className="justify-self-start">
              Save runtime settings
            </Button>
          </form>
        )}
      </SettingsGroup>
    </>
  );
}
