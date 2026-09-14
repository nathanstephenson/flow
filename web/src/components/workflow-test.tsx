import { useState } from "react";
import type {
  Json,
  WorkflowDefinition,
} from "../../../src/protocol/workflows.ts";
import type {
  WorkflowExecutionList,
  WorkflowExecutionView,
} from "../../../src/protocol/workflow-executions.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { validatedStepInput, startIssue, workflowIssue } from "../presentation/workflows.ts";
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
    schema = validateDefinition(definition).inputSchemas.get(stepId);
    validatedStepInput(definition, stepId, input);
  } catch (e) {
    invalid = workflowIssue(e);
  }
  const session = sessions.find((s) => s.id === sessionId);
  const issue = session
    ? startIssue(definition, session.backend, slot.data?.occupied ?? true)
    : "Select an Agent Session explicitly";
  return (
    <fieldset className="border p-2 grid gap-2">
      <legend>Test only this step</legend>
      <p>
        Uses the selected Agent Session’s Scope and workflow slot. Outgoing
        connections do not execute. Tests use this unsaved definition.
      </p>
      <select
        aria-label="Test Agent Session"
        value={sessionId}
        onChange={(e) => setSessionId(e.target.value)}
      >
        <option value="">Select Agent Session</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id} · {s.backend}
          </option>
        ))}
      </select>
      {schema && (
        <>
          <button onClick={() => setInput(initialValue(schema))}>
            Use sample defaults
          </button>
          <ValueEditor schema={schema} value={input} onChange={setInput} />
        </>
      )}
      <p role="status">{slot.error || issue || invalid || message}</p>
      <button
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
      </button>
    </fieldset>
  );
}
