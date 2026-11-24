import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { WorkflowOccurrence, WorkflowSchedule, WorkflowScheduleSettings, WorkflowTiming } from '../protocol/workflow-schedules.ts';
import type { WorkflowExecution } from '../protocol/workflows.ts';

export const SCHEDULE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LIVE_DISPATCH_TOLERANCE_MS = 30_000;
export const storageId = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(200);
export const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const timezone = z.string().max(200).refine(value => {
  try {
    // Temporal also accepts numeric offsets; schedules deliberately require named zones.
    return !/^[+\-\u2212]/.test(value) && Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value).timeZoneId.length > 0;
  } catch { return false; }
}, 'Invalid IANA timezone');
export const timingValidator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), value: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), unit: z.enum(['minutes', 'hours', 'days']) }).strict().refine(value => Number.isSafeInteger(value.value * intervalUnit(value.unit)) && value.value * intervalUnit(value.unit) <= 8_640_000_000_000_000, 'Interval is too large'),
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timezone }).strict(),
]);
export const scheduleSettingsValidator = z.object({
  name: z.string().trim().min(1).max(200), workflowId: storageId,
  input: z.json(), projectId: z.string().min(1).max(4096),
  mcpConnectionIds: z.array(storageId).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate MCP selection'),
  worktree: z.object({ from: z.string().min(1).max(1024) }).strict().optional(),
  timing: timingValidator, concurrency: z.number().int().min(1).max(100).default(3),
}).strict();
export const scheduleValidator = scheduleSettingsValidator.extend({
  version: z.literal(1), id: storageId, revision: z.number().int().positive(), activation: z.number().int().nonnegative(),
  enabled: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
  nextDue: timestamp.optional(), deletedAt: timestamp.optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled !== (value.nextDue !== undefined) || (value.deletedAt !== undefined && value.enabled)) context.addIssue({ code: 'custom', message: 'Invalid schedule cursor' });
  if (value.enabled && value.activation < 1) context.addIssue({ code: 'custom', message: 'Missing activation' });
});
export const occurrenceValidator = z.object({
  version: z.literal(1), id: storageId, scheduleId: storageId,
  activation: z.number().int().positive(), revision: z.number().int().positive(), scheduledAt: timestamp,
  missedThrough: timestamp.optional(), settings: scheduleSettingsValidator,
  status: z.enum(['provisioning', 'running', 'recovery-required', 'completed', 'completed-with-recovery', 'cancelled', 'launch-failed', 'interrupted', 'capacity-skipped', 'missed']),
  createdAt: timestamp, finishedAt: timestamp.optional(), sessionId: storageId.optional(), association: z.enum(['pending', 'attached', 'failed']).optional(), executionId: storageId.optional(),
  scope: z.string().min(1).optional(), worktree: z.object({ path: z.string(), repo: z.string(), branch: z.string() }).strict().optional(),
  outcome: z.string().max(2000).optional(),
  warning: z.string().max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.id !== occurrenceId(value.scheduleId, value.activation, value.scheduledAt)) context.addIssue({ code: 'custom', message: 'Invalid occurrence identity' });
  if (isActiveOccurrence(value) === (value.finishedAt !== undefined)) context.addIssue({ code: 'custom', message: 'Invalid occurrence completion' });
  if (value.missedThrough !== undefined && (value.status !== 'missed' || value.missedThrough < value.scheduledAt)) context.addIssue({ code: 'custom', message: 'Invalid missed range' });
});
function intervalUnit(unit: 'minutes' | 'hours' | 'days'): number { return { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[unit]; }
export function intervalMilliseconds(timing: Extract<WorkflowTiming, { kind: 'interval' }>): number {
  timingValidator.parse(timing);
  return timing.value * intervalUnit(timing.unit);
}
export function occurrenceId(scheduleId: string, activation: number, due: number): string {
  storageId.parse(scheduleId); z.number().int().positive().parse(activation); timestamp.parse(due);
  return createHash('sha256').update(JSON.stringify([scheduleId, activation, due])).digest('hex');
}
/** Strictly future civil-time match. Gaps are skipped; folds use only their earlier instant. */
export function nextOccurrence(timing: WorkflowTiming, after: number): number {
  timingValidator.parse(timing); timestamp.parse(after);
  if (timing.kind === 'interval') return timestamp.parse(after + intervalMilliseconds(timing));
  const instant = Temporal.Instant.fromEpochMilliseconds(after);
  let date = instant.toZonedDateTimeISO(timing.timezone).toPlainDate();
  const time = Temporal.PlainTime.from(timing.time);
  // IANA transitions can skip a date, but cannot exhaust a week of daily candidates.
  for (let day = 0; day < 8; day++, date = date.add({ days: 1 })) {
    const civil = date.toPlainDateTime(time);
    const candidate = civil.toZonedDateTime(timing.timezone, { disambiguation: 'earlier' });
    if (!candidate.toPlainDateTime().equals(civil)) continue;
    const due = candidate.epochMilliseconds;
    if (due > after) return timestamp.parse(due);
  }
  throw new Error('No representable future occurrence');
}
/** Advance an interval in constant time; daily timing is resolved directly at the target date. */
export function advancePast(timing: WorkflowTiming, due: number, through: number): number {
  timestamp.parse(due); timestamp.parse(through);
  if (due > through) return due;
  if (timing.kind === 'interval') {
    const interval = intervalMilliseconds(timing);
    return timestamp.parse(due + (Math.floor((through - due) / interval) + 1) * interval);
  }
  return nextOccurrence(timing, through);
}
export function isActiveOccurrence(value: Pick<WorkflowOccurrence, 'status'>): boolean {
  return ['provisioning', 'running', 'recovery-required'].includes(value.status);
}
export function projectExecution(occurrence: WorkflowOccurrence, execution: WorkflowExecution, now: number): WorkflowOccurrence {
  if (execution.occurrenceId !== occurrence.id) throw new Error('Execution occurrence mismatch');
  const { finishedAt: _, ...saved } = occurrence;
  return { ...saved, executionId: execution.id, ...(execution.sessionId ? { sessionId: execution.sessionId } : {}), status: execution.status,
    ...(isActiveOccurrence(execution) ? {} : { finishedAt: execution.finishedAt ?? now }) };
}
export function createSchedule(settings: WorkflowScheduleSettings, now: number, enabled = false): WorkflowSchedule {
  const validated = scheduleSettingsValidator.parse(settings);
  timestamp.parse(now);
  return scheduleValidator.parse({ ...validated, version: 1, id: randomUUID(), revision: 1, activation: enabled ? 1 : 0, enabled, createdAt: now, updatedAt: now, ...(enabled ? { nextDue: nextOccurrence(validated.timing, now) } : {}) });
}
/** Timing edits and false→true activation reset the anchor; unrelated edits preserve it. */
export function editSchedule(saved: WorkflowSchedule, settings: WorkflowScheduleSettings, enabled: boolean, now: number): WorkflowSchedule {
  scheduleValidator.parse(saved); timestamp.parse(now);
  if (saved.deletedAt !== undefined) throw new Error('Schedule was deleted');
  const validated = scheduleSettingsValidator.parse(settings);
  const activate = enabled && (!saved.enabled || !isDeepStrictEqual(saved.timing, validated.timing));
  const { nextDue: previousDue, ...rest } = saved;
  return scheduleValidator.parse({ ...rest, ...validated, revision: saved.revision + 1, activation: saved.activation + Number(activate), enabled, updatedAt: now,
    ...(enabled ? { nextDue: activate ? nextOccurrence(validated.timing, now) : previousDue } : {}) });
}
export function occurrenceSettings(schedule: WorkflowSchedule): WorkflowScheduleSettings {
  const { name, workflowId, input, projectId, mcpConnectionIds, timing, concurrency, worktree } = schedule;
  return structuredClone({ name, workflowId, input, projectId, mcpConnectionIds, timing, concurrency, ...(worktree ? { worktree } : {}) });
}
