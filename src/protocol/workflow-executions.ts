import type { BackendEvent, PermissionDecision, Question, Spend } from './events.ts';
import type { ExecutionStatus, Json, WorkflowDefinition, WorkflowExecution } from './workflows.ts';

export interface WorkflowActivity {
  sequence: number;
  attempt?: number;
  at: number;
  stepId: string;
  subagentId: string;
  event: BackendEvent | { type: 'spend'; spend: Spend };
}

export interface WorkflowEnquiry {
  stepId: string;
  subagentId: string;
  askId: string;
  questions: Question[];
}

export interface WorkflowPermissionPrompt {
  direct?: boolean;
  stepId: string;
  subagentId: string;
  callId: string;
  tool: string;
  /** The original call arguments, when the Workflow Step exposed them. */
  details?: unknown;
  /** Human-readable authorization boundary carried into the parent relay. */
  scope?: string;
}

export interface WorkflowExecutionView {
  execution: WorkflowExecution;
  activity: WorkflowActivity[];
  /** False for legacy runs whose evicted history cannot be reconstructed. */
  historyComplete?: boolean;
  enquiries: WorkflowEnquiry[];
  permissions: WorkflowPermissionPrompt[];
  stepSpend: Record<string, Spend>;
  spend?: Spend;
}

export interface WorkflowExecutionSummary {
  id: string;
  workflowId: string;
  name: string;
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  testStepId?: string;
}

export interface WorkflowExecutionList {
  executions: WorkflowExecutionSummary[];
  occupied: boolean;
}

export interface WorkflowRuntimeStatus {
  externalSandbox: boolean;
  dockerImage: string;
  available: boolean;
  error?: string;
  nodePath?: string;
  dockerPath?: string;
}

export type StartWorkflow = { workflowId: string; input: Json; /** Durable identity making an ambiguous launch safe to retry. */ launchId?: string; /** Name a just-created Agent Session from this launch. */ nameSession?: true };
export type TestWorkflowStep = { definition: WorkflowDefinition; sessionId: string; stepId: string; input: Json };
export type RecoverWorkflow = { kind: 'retry'; stepId: string } | { kind: 'supply'; stepId: string; output: Json } | { kind: 'continue' } | { kind: 'extend-loop'; headerId: string; activation: number; try: number; guidance?: string | undefined };
export type AnswerWorkflowEnquiry = { subagentId: string; askId: string; answers: string[][] };
export type AnswerWorkflowPermission = { subagentId: string; callId: string; decision: PermissionDecision };

export interface WorkflowActivityPage {
  /** Always ascending by sequence, including pages fetched from the tail. */
  activity: WorkflowActivity[];
  /** Forward cursor for activity newer than this page. */
  next?: number;
  /** Backward cursor for retained activity older than this page. */
  previous?: number;
  historyComplete: boolean;
}
