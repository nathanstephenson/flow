import type { EffortLevel } from './events.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type VisualSchema =
  | { type: 'string' }
  | { type: 'number'; integer?: boolean }
  | { type: 'boolean' }
  | { type: 'enum'; values: string[] }
  | { type: 'array'; items: VisualSchema }
  | { type: 'union'; variants: VisualSchema[] }
  | { type: 'object'; fields: Record<string, SchemaField> };

export interface SchemaField {
  schema: VisualSchema;
  required?: boolean;
  default?: Json;
}

export type InputReference = { source: 'input'; path: string[] } | { source: 'step'; stepId: string; path: string[] };
export type InputMapping = { kind: 'reference'; reference: InputReference } | { kind: 'object'; fields: Record<string, InputReference> };
export type WorkflowPermission = 'ask' | 'auto-accept';
export type WorkflowOutcome = 'success' | 'failure' | 'timeout' | 'true' | 'false';

interface StepBase {
  id: string;
  name: string;
  inputSchema?: VisualSchema;
  mapping?: InputMapping;
  repeatMapping?: InputMapping;
  permission?: WorkflowPermission;
  timeoutMs?: number;
  secrets?: Record<string, string>;
  position?: { x: number; y: number };
}

export type WorkflowStep = StepBase & (
  | { kind: 'agent'; instructions: string; model: string; effort: EffortLevel; outputSchema: VisualSchema }
  | { kind: 'shell'; command: string; acceptedExitCodes?: number[] }
  | { kind: 'typescript'; code: string; outputSchema: VisualSchema }
  | { kind: 'branch'; condition: BranchCondition }
  | { kind: 'join' }
);

export type BranchCondition =
  | { operator: 'truthy'; path: string[] }
  | { operator: 'equals' | 'not-equals'; path: string[]; value: Json }
  | { operator: 'greater-than' | 'less-than'; path: string[]; value: number };

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  outcome: WorkflowOutcome;
}

export interface WorkflowDefinition {
  version: 1;
  id: string;
  name: string;
  backend: string;
  projectId?: string;
  permission?: WorkflowPermission;
  inputSchema: Extract<VisualSchema, { type: 'object' }>;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  loopSettings?: Record<string, { maxTries: number }>;
}

export interface WorkflowError {
  message: string;
  kind: 'failure' | 'timeout' | 'interrupted';
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped' | 'blocked' | 'cancelled';
export interface LoopTryIdentity {
  headerId: string;
  activation: number;
  try: number;
}
export interface WorkflowLoopRecord {
  activation: number;
  try: number;
  phase: 'inactive' | 'active' | 'repeating' | 'limit' | 'exited';
  headerInput?: Json;
  headerRecovery?: boolean;
  grants: Array<{ activation: number; try: number; guidance?: string }>;
}
export interface StepAttempt {
  loops?: LoopTryIdentity[];
  number: number;
  action: 'execute' | 'retry' | 'supply';
  startedAt: number;
  finishedAt?: number;
  input: Json;
  output?: Json;
  partialOutput?: Json;
  error?: WorkflowError;
}
export interface WorkflowStepRecord {
  status: StepStatus;
  recovery?: boolean;
  attempts: StepAttempt[];
  output?: Json;
  outcome?: WorkflowOutcome;
}
export type ExecutionStatus = 'running' | 'recovery-required' | 'completed' | 'completed-with-recovery' | 'cancelled';
export interface WorkflowExecution {
  version: 1;
  id: string;
  sessionId: string;
  scope: string;
  definition: WorkflowDefinition;
  input: Json;
  testStepId?: string;
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  steps: Record<string, WorkflowStepRecord>;
  loops?: Record<string, WorkflowLoopRecord>;
  result?: Json;
}
