import type { EffortLevel, Spend } from './events.ts';
import type { WorkflowDefinition } from './workflows.ts';

export interface CreateWorkflowBuilder {
  definition: WorkflowDefinition;
  modelId?: string;
  effort?: EffortLevel;
}
export interface WorkflowBuilderView {
  id: string;
  definition: WorkflowDefinition;
  scope: string;
  status: 'idle' | 'running' | 'error';
  /** Capability revocation is immediate, but the retiring Backend Session is still being disposed. */
  stopping?: boolean;
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; final?: boolean }>;
  error?: string;
  spend?: Spend;
  contextUsage?: { used: number; window: number };
}
export interface WorkflowBuilderMessage { text: string }
