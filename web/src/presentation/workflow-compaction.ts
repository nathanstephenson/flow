/**
 * Whether one Workflow Step attempt can truthfully show compaction in progress.
 *
 * The adapter's lifecycle signal drives live attempts. A terminal attempt always wins over a stale
 * retained `active: true`: no work can still be in flight after completion, failure, or cancellation.
 */
export function showWorkflowCompacting(active: true | undefined, completed: boolean): boolean {
  return !completed && active === true;
}
