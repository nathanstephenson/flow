import type { Json } from "../../src/protocol/workflows.ts";

/**
 * The one workflow draft that survives leaving the New Agent Session page: a launch whose Agent
 * Session was created but whose Workflow Execution was not. Memory-only on purpose; ordinary
 * workflow drafts do not persist navigation, and a host restart must never replay this automatically.
 */
export type RetainedWorkflowLaunch = {
  launchId: string;
  workflowId: string;
  input: Json;
  error: string;
};

const retained = new Map<string, RetainedWorkflowLaunch>();

export function retainWorkflowLaunch(sessionId: string, launch: RetainedWorkflowLaunch): void {
  retained.set(sessionId, structuredClone(launch));
}

export function retainedWorkflowLaunch(sessionId: string): RetainedWorkflowLaunch | undefined {
  const launch = retained.get(sessionId);
  return launch && structuredClone(launch);
}

export function clearRetainedWorkflowLaunch(sessionId: string): void {
  retained.delete(sessionId);
}

export function pruneRetainedWorkflowLaunch(sessionIds: ReadonlySet<string>): void {
  for (const sessionId of retained.keys()) if (!sessionIds.has(sessionId)) retained.delete(sessionId);
}
