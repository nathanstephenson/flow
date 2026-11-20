import type { WorkflowSchedule, WorkflowTiming } from '../../../src/protocol/workflow-schedules.ts';
export function scheduleTiming(timing: WorkflowTiming): string {
  return timing.kind === 'daily' ? `Daily at ${timing.time} · ${timing.timezone}` : `Every ${timing.value} ${timing.unit}`;
}
export function scheduleState(schedule: WorkflowSchedule): string { return schedule.deletedAt !== undefined ? 'Deleted' : schedule.enabled ? 'Enabled' : 'Paused'; }
export function sharedDirectoryWarning(worktree: unknown): string | undefined { return worktree ? undefined : 'Shared directory: overlapping runs can edit the same files. Use fresh worktrees to separate runs.'; }
