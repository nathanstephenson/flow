import { useState } from "react";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import type {
  Json,
  WorkflowDefinition,
} from "../../../src/protocol/workflows.ts";
import type {
  WorkflowExecutionList,
  WorkflowExecutionView,
} from "../../../src/protocol/workflow-executions.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import {
  validatedStepInput,
  startIssue,
  workflowIssue,
} from "../presentation/workflows.ts";
import { useAgentSessions } from "../agent-sessions.tsx";
import { ValueEditor, initialValue } from "./workflow-editors.tsx";
import { useWorkflowResource, workflowApi } from "./workflow-api.ts";
export function StepTest({
  definition,
  stepId,
}: {
  definition: WorkflowDefinition;
  stepId: string;
}) {
  const { sessions } = useAgentSessions();
  const [sessionId, setSessionId] = useState("");
  const [input, setInput] = useState<Json>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const slot = useWorkflowResource<WorkflowExecutionList>(
    sessionId ? `/api/sessions/${sessionId}/workflows` : undefined,
  );
  let schema;
  let invalid = "";
  try {
    const step = definition.steps.find(step => step.id === stepId);
    schema = step?.kind === "mcp" ? { type: "json" as const, schema: step.tool.inputSchema } : validateDefinition(definition).inputSchemas.get(stepId);
    validatedStepInput(definition, stepId, input);
  } catch (e) {
    invalid = workflowIssue(e);
  }
  const session = sessions.find((s) => s.id === sessionId);
  const issue = session
    ? startIssue(definition, session.backend, slot.data?.occupied ?? true)
    : "Select an Agent Session explicitly";
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Test only this step</legend>
      <p className="text-xs text-muted-foreground">
        Uses the selected Agent Session’s Scope and workflow slot. Outgoing
        connections do not execute. Tests use this unsaved definition.
      </p>
      <Select
        value={sessionId}
        onValueChange={(value) => value !== null && setSessionId(value)}
      >
        <SelectTrigger className="w-full" aria-label="Test Agent Session">
          <SelectValue>
            {session
              ? `${session.id} · ${session.backend}`
              : "Select Agent Session"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Select Agent Session</SelectItem>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.id} · {s.backend}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {schema && (
        <>
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => setInput(initialValue(schema))}
          >
            Use sample defaults
          </Button>
          <ValueEditor schema={schema} value={input} onChange={setInput} />
        </>
      )}
      <p className="text-xs text-muted-foreground" role="status">
        {slot.error || issue || invalid || message}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="justify-self-start"
        disabled={busy || !!issue || !!invalid || !!slot.error}
        onClick={async () => {
          setBusy(true);
          try {
            const view = await workflowApi<WorkflowExecutionView>(
              "/api/workflows/test",
              "POST",
              { definition, sessionId, stepId, input },
            );
            setMessage(
              `Test ${view.execution.id}: ${view.execution.status}. Open this Agent Session’s Workflows tab to inspect it.`,
            );
          } catch (e) {
            setMessage(workflowIssue(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Test selected step
      </Button>
    </fieldset>
  );
}
