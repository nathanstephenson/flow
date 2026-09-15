import type { BackendEvent, PermissionDecision, Question, Spend } from './events.ts';
import type { ExecutionStatus, Json, WorkflowDefinition, WorkflowExecution } from './workflows.ts';

export interface WorkflowActivity {
  sequence: number;
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
}

export interface WorkflowExecutionView {
  execution: WorkflowExecution;
  activity: WorkflowActivity[];
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

export type StartWorkflow = { workflowId: string; input: Json };
export type TestWorkflowStep = { definition: WorkflowDefinition; sessionId: string; stepId: string; input: Json };
export type RecoverWorkflow = { kind: 'retry'; stepId: string } | { kind: 'supply'; stepId: string; output: Json } | { kind: 'continue' } | { kind: 'extend-loop'; headerId: string; activation: number; try: number; guidance?: string };
export type AnswerWorkflowEnquiry = { subagentId: string; askId: string; answers: string[][] };
export type AnswerWorkflowPermission = { subagentId: string; callId: string; decision: PermissionDecision };
