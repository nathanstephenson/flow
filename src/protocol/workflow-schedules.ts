import type { Json } from './workflows.ts';

export type WorkflowTiming = { kind: 'interval'; value: number; unit: 'minutes' | 'hours' | 'days' } | { kind: 'daily'; time: string; timezone: string };
export interface WorkflowScheduleSettings {
  name: string;
  workflowId: string;
  input: Json;
  projectId: string;
  mcpConnectionIds: string[];
  worktree?: { from: string } | undefined;
  timing: WorkflowTiming;
  concurrency: number;
}
export interface WorkflowSchedule extends WorkflowScheduleSettings {
  version: 1;
  id: string;
  revision: number;
  activation: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextDue?: number | undefined;
  deletedAt?: number | undefined;
}
export type WorkflowOccurrenceStatus = 'provisioning' | 'running' | 'recovery-required' | 'completed' | 'completed-with-recovery' | 'cancelled' | 'launch-failed' | 'interrupted' | 'capacity-skipped' | 'missed';
export interface WorkflowOccurrence {
  version: 1;
  id: string;
  scheduleId: string;
  activation: number;
  revision: number;
  scheduledAt: number;
  /** Last due time of a grouped downtime gap (not an execution backlog). */
  missedThrough?: number | undefined;
  settings: WorkflowScheduleSettings;
  status: WorkflowOccurrenceStatus;
  createdAt: number;
  finishedAt?: number | undefined;
  sessionId?: string | undefined;
  association?: 'pending' | 'attached' | 'failed' | undefined;
  executionId?: string | undefined;
  scope?: string | undefined;
  worktree?: { path: string; repo: string; branch: string } | undefined;
  /** Deliberately generic: external diagnostics may contain credentials. */
  outcome?: string | undefined;
}
export interface WorkflowOccurrencePage { occurrences: WorkflowOccurrence[]; next?: string }
