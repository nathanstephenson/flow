import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowOccurrence, WorkflowOccurrencePage, WorkflowSchedule } from '../protocol/workflow-schedules.ts';
import { ScheduleValidationError } from './schedule-errors.ts';
import { isActiveOccurrence, occurrenceValidator, scheduleValidator, SCHEDULE_RETENTION_MS, storageId, timestamp } from './schedules.ts';

function sync(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableDirectory(directory: string): void {
  if (existsSync(directory)) return;
  const parent = dirname(directory);
  durableDirectory(parent);
  mkdirSync(directory, { mode: 0o700 });
  sync(parent);
}
function atomicWrite(path: string, value: unknown): void {
  const directory = dirname(path);
  durableDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); sync(directory);
  } finally { rmSync(temporary, { force: true }); }
}
function ids(directory: string, invalid?: () => void): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    const id = storageId.safeParse(name.slice(0, -5));
    if (id.success) return [id.data];
    invalid?.();
    console.error('Workflow Schedule record has an invalid filename. File retained for manual review.');
    return [];
  });
}
const cleanupJournalValidator = z.object({ occurrenceId: storageId, status: z.enum(['pending', 'done']) }).strict();
function needsUnstartedCleanup(value: WorkflowOccurrence): boolean {
  return value.executionId === undefined && ['interrupted', 'launch-failed', 'cancelled'].includes(value.status);
}
export class ScheduleRecordNotFound extends Error {}
export class ScheduleRevisionConflict extends Error {
  constructor() { super('Schedule changed; reload before editing'); }
}
/** Private, durable records independent of Agent Session lifecycle and transcript retention. */
export class WorkflowScheduleStore {
  readonly root: string;
  private readonly schedules = new Map<string, WorkflowSchedule>();
  private readonly occurrences = new Map<string, Pick<WorkflowOccurrence, 'id' | 'scheduleId' | 'scheduledAt' | 'status' | 'finishedAt'>>();
  private readonly activeRecords = new Map<string, WorkflowOccurrence>();
  private readonly history: string[] = [];
  private readonly historyBySchedule = new Map<string, string[]>();
  private readonly active = new Set<string>();
  private readonly activeBySchedule = new Map<string, Set<string>>();
  private projection: ((occurrence: WorkflowOccurrence) => WorkflowOccurrence) | undefined;
  private pruning: Promise<string[]> | undefined;
  private unknownOccurrences = false;
  private readonly unstartedCleanup = new Map<string, 'pending' | 'done' | 'unknown'>();
  constructor(stateRoot: string) {
    this.root = join(stateRoot, 'workflow-schedules');
    for (const id of ids(join(this.root, 'unstarted-cleanup'))) {
      try {
        const value = cleanupJournalValidator.parse(JSON.parse(readFileSync(this.cleanupPath(id), 'utf8')));
        if (value.occurrenceId !== id) throw new Error('Invalid cleanup identity');
        this.unstartedCleanup.set(id, value.status);
      } catch {
        this.unstartedCleanup.set(id, 'unknown');
        console.error('Workflow Occurrence cleanup journal is invalid. File retained for manual review.');
      }
    }
    for (const id of ids(join(this.root, 'definitions'))) {
      try {
        const value = scheduleValidator.parse(JSON.parse(readFileSync(this.schedulePath(id), 'utf8')));
        if (value.id !== id) throw new Error('Invalid schedule identity');
        this.schedules.set(id, value);
      } catch { console.error('Workflow Schedule record is invalid. File retained for manual review.'); }
    }
    for (const id of ids(join(this.root, 'occurrences'), () => { this.unknownOccurrences = true; })) {
      try {
        const value = occurrenceValidator.parse(JSON.parse(readFileSync(this.occurrencePath(id), 'utf8')));
        if (value.id !== id) throw new Error('Invalid occurrence identity');
        this.indexOccurrence(value);
        try { this.queueUnstartedCleanup(value); }
        catch {
          this.unstartedCleanup.set(id, 'pending');
          console.error('Workflow Occurrence cleanup journal could not be saved. Its record will be retained for retry.');
        }
      } catch {
        this.unknownOccurrences = true;
        console.error('Workflow Occurrence record is invalid. File retained for manual review.');
      }
    }
  }
  private cleanupPath(id: string): string { return join(this.root, 'unstarted-cleanup', `${storageId.parse(id)}.json`); }
  private queueUnstartedCleanup(value: WorkflowOccurrence): void {
    if (!needsUnstartedCleanup(value) || this.unstartedCleanup.has(value.id)) return;
    atomicWrite(this.cleanupPath(value.id), { occurrenceId: value.id, status: 'pending' });
    this.unstartedCleanup.set(value.id, 'pending');
  }
  pendingUnstartedCleanup(): string[] { return [...this.unstartedCleanup].filter(([, status]) => status === 'pending').map(([id]) => id); }
  prepareUnstartedCleanup(id: string): void {
    atomicWrite(this.cleanupPath(id), { occurrenceId: id, status: 'pending' });
  }
  completeUnstartedCleanup(id: string): void {
    atomicWrite(this.cleanupPath(id), { occurrenceId: id, status: 'done' });
    this.unstartedCleanup.set(id, 'done');
  }
  setOccurrenceProjection(project: (occurrence: WorkflowOccurrence) => WorkflowOccurrence): void { this.projection = project; }
  private project(value: WorkflowOccurrence): WorkflowOccurrence {
    const copy = structuredClone(value);
    return isActiveOccurrence(value) && this.projection ? this.projection(copy) : copy;
  }
  private indexOccurrence(value: WorkflowOccurrence): void {
    const fresh = !this.occurrences.has(value.id);
    const { id, scheduleId, scheduledAt, status, finishedAt } = value;
    this.occurrences.set(id, { id, scheduleId, scheduledAt, status, ...(finishedAt === undefined ? {} : { finishedAt }) });
    if (isActiveOccurrence(value)) this.activeRecords.set(id, value);
    else this.activeRecords.delete(id);
    const active = this.activeBySchedule.get(value.scheduleId) ?? new Set<string>();
    this.activeBySchedule.set(value.scheduleId, active);
    if (isActiveOccurrence(value)) { this.active.add(value.id); active.add(value.id); }
    else { this.active.delete(value.id); active.delete(value.id); }
    if (!fresh) return;
    const history = this.historyBySchedule.get(value.scheduleId) ?? [];
    this.historyBySchedule.set(value.scheduleId, history);
    for (const list of [this.history, history]) {
      let low = 0, high = list.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const other = this.occurrences.get(list[mid]!)!;
        if (other.scheduledAt > value.scheduledAt || (other.scheduledAt === value.scheduledAt && other.id > value.id)) low = mid + 1;
        else high = mid;
      }
      list.splice(low, 0, value.id);
    }
  }
  private historyIds(scheduleId?: string): string[] {
    if (scheduleId === undefined) return this.history;
    storageId.parse(scheduleId);
    return this.historyBySchedule.get(scheduleId) ?? [];
  }
  listActiveOccurrences(scheduleId?: string): WorkflowOccurrence[] {
    if (scheduleId !== undefined) storageId.parse(scheduleId);
    const active = scheduleId === undefined ? this.active : this.activeBySchedule.get(scheduleId) ?? [];
    return [...active].map(id => this.getOccurrence(id)).filter(isActiveOccurrence);
  }
  activeCount(scheduleId?: string): number { return this.listActiveOccurrences(scheduleId).length; }
  private schedulePath(id: string): string { return join(this.root, 'definitions', `${storageId.parse(id)}.json`); }
  private occurrencePath(id: string): string { return join(this.root, 'occurrences', `${storageId.parse(id)}.json`); }
  getSchedule(id: string): WorkflowSchedule {
    storageId.parse(id);
    const value = this.schedules.get(id);
    if (!value) throw new ScheduleRecordNotFound('Schedule not found');
    return structuredClone(value);
  }
  listSchedules(includeDeleted = false): WorkflowSchedule[] {
    return [...this.schedules.values()].filter(value => includeDeleted || value.deletedAt === undefined).map(value => structuredClone(value));
  }
  saveSchedule(value: WorkflowSchedule, expectedRevision?: number): void {
    const validated = scheduleValidator.parse(value);
    const path = this.schedulePath(validated.id);
    if (expectedRevision === undefined) {
      if (existsSync(path)) throw new ScheduleRevisionConflict();
    } else if (this.getSchedule(validated.id).revision !== expectedRevision || validated.revision !== expectedRevision + 1) throw new ScheduleRevisionConflict();
    atomicWrite(path, validated);
    this.schedules.set(validated.id, validated);
  }
  /** Cursor advancement is not a user edit and retains the activation/revision. */
  advanceCursor(id: string, revision: number, due: number, nextDue: number): void {
    const saved = this.getSchedule(id);
    if (!saved.enabled || saved.revision !== revision || saved.nextDue !== due) throw new ScheduleRevisionConflict();
    if (nextDue <= due) throw new Error('Schedule cursor must advance');
    const value = scheduleValidator.parse({ ...saved, nextDue });
    atomicWrite(this.schedulePath(id), value);
    this.schedules.set(id, value);
  }
  deleteSchedule(id: string, revision: number, now: number): void {
    const saved = this.getSchedule(id);
    const { nextDue: _, ...rest } = saved;
    this.saveSchedule({ ...rest, enabled: false, revision: saved.revision + 1, deletedAt: timestamp.parse(now), updatedAt: now }, revision);
  }
  private readOccurrence(id: string): WorkflowOccurrence {
    storageId.parse(id);
    if (!this.occurrences.has(id)) throw new ScheduleRecordNotFound('Occurrence not found');
    const value = this.activeRecords.get(id) ?? occurrenceValidator.parse(JSON.parse(readFileSync(this.occurrencePath(id), 'utf8')));
    if (value.id !== id) throw new Error('Invalid occurrence identity');
    return value;
  }
  getStoredOccurrence(id: string): WorkflowOccurrence { return structuredClone(this.readOccurrence(id)); }
  getOccurrence(id: string): WorkflowOccurrence { return this.project(this.readOccurrence(id)); }
  listOccurrences(scheduleId?: string): WorkflowOccurrence[] {
    return this.historyIds(scheduleId).map(id => this.getOccurrence(id));
  }
  page(options: { scheduleId?: string; before?: string | undefined; limit?: number } = {}): WorkflowOccurrencePage {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ScheduleValidationError('Invalid history limit');
    const values = this.historyIds(options.scheduleId);
    let start = 0;
    if (options.before !== undefined) {
      if (!storageId.safeParse(options.before).success) throw new ScheduleValidationError('Invalid history cursor');
      const cursor = /^(\d+)_([a-f0-9]{64})$/.exec(options.before);
      if (cursor) {
        const parsed = timestamp.safeParse(Number(cursor[1]));
        if (!parsed.success) throw new ScheduleValidationError('Invalid history cursor');
        const due = parsed.data, id = cursor[2]!;
        let high = values.length;
        while (start < high) {
          const mid = (start + high) >>> 1, other = this.occurrences.get(values[mid]!)!;
          if (other.scheduledAt > due || (other.scheduledAt === due && other.id >= id)) start = mid + 1;
          else high = mid;
        }
      } else {
        const index = values.indexOf(options.before);
        if (index < 0) throw new ScheduleValidationError('Invalid history cursor');
        start = index + 1;
      }
    }
    const last = this.occurrences.get(values[start + limit - 1]!);
    return { occurrences: values.slice(start, start + limit).map(id => this.getOccurrence(id)), ...(values.length > start + limit ? { next: `${last!.scheduledAt}_${last!.id}` } : {}) };
  }
  /** Durable admission claim. Call before provisioning or executable effects; never overwrite. */
  claimOccurrence(value: WorkflowOccurrence): boolean {
    const validated = occurrenceValidator.parse(value);
    if (this.occurrences.has(value.id) || existsSync(this.occurrencePath(value.id))) return false;
    this.queueUnstartedCleanup(validated);
    atomicWrite(this.occurrencePath(value.id), validated);
    this.indexOccurrence(validated);
    return true;
  }
  saveOccurrence(value: WorkflowOccurrence): void {
    const validated = occurrenceValidator.parse(value);
    const saved = this.readOccurrence(validated.id);
    if (saved.scheduleId !== value.scheduleId || saved.activation !== value.activation || saved.scheduledAt !== value.scheduledAt || saved.revision !== value.revision) throw new Error('Occurrence identity cannot change');
    if (!isDeepStrictEqual(saved.settings, validated.settings)) throw new Error('Occurrence settings cannot change');
    if (!isActiveOccurrence(saved) && !isDeepStrictEqual(saved, validated)) throw new Error('Terminal occurrence is immutable');
    this.queueUnstartedCleanup(validated);
    atomicWrite(this.occurrencePath(value.id), validated);
    this.indexOccurrence(validated);
  }
  saveCleanupWarning(occurrence: WorkflowOccurrence, warning: string): void {
    atomicWrite(join(this.root, 'cleanup', `${storageId.parse(occurrence.id)}.json`), { occurrenceId: occurrence.id, worktree: occurrence.worktree, warning });
  }
  clearCleanupWarning(id: string): void {
    const path = join(this.root, 'cleanup', `${storageId.parse(id)}.json`);
    if (!existsSync(path)) return;
    rmSync(path); sync(dirname(path));
  }
  cleanupWarnings(): unknown[] {
    return ids(join(this.root, 'cleanup')).flatMap(id => {
      try { return [JSON.parse(readFileSync(join(this.root, 'cleanup', `${id}.json`), 'utf8')) as unknown]; }
      catch { console.error('Workflow Occurrence cleanup warning is invalid. File retained for manual review.'); return []; }
    });
  }

  /** The callback owns execution cleanup; no Agent Session directories are ever removed here. */
  prune(now: number, cleanup: (occurrence: WorkflowOccurrence) => Promise<void>, canPrune: (id: string) => boolean = () => true): Promise<string[]> {
    this.pruning ??= this.pruneExpired(now, cleanup, canPrune).finally(() => { this.pruning = undefined; });
    return this.pruning;
  }
  private async pruneExpired(now: number, cleanup: (occurrence: WorkflowOccurrence) => Promise<void>, canPrune: (id: string) => boolean): Promise<string[]> {
    timestamp.parse(now);
    const removed: string[] = [];
    for (const id of [...this.history]) {
      if (!canPrune(id)) continue;
      const indexed = this.occurrences.get(id)!;
      if (!isActiveOccurrence(indexed) && (indexed.finishedAt === undefined || indexed.finishedAt > now - SCHEDULE_RETENTION_MS)) continue;
      try {
        const value = this.getOccurrence(id);
        if (isActiveOccurrence(value) || value.finishedAt === undefined || value.finishedAt > now - SCHEDULE_RETENTION_MS) continue;
        if (this.active.has(value.id)) this.saveOccurrence(value);
        await cleanup(value);
        if (this.unstartedCleanup.has(id) && this.unstartedCleanup.get(id) !== 'unknown') {
          rmSync(this.cleanupPath(id), { force: true }); sync(dirname(this.cleanupPath(id)));
          this.unstartedCleanup.delete(id);
        }
        rmSync(this.occurrencePath(value.id)); sync(dirname(this.occurrencePath(value.id)));
        this.occurrences.delete(value.id);
        this.activeRecords.delete(value.id);
        this.active.delete(value.id);
        this.activeBySchedule.get(value.scheduleId)?.delete(value.id);
        const history = this.historyBySchedule.get(value.scheduleId)!;
        for (const list of [this.history, history]) list.splice(list.indexOf(value.id), 1);
        if (!history.length) { this.historyBySchedule.delete(value.scheduleId); this.activeBySchedule.delete(value.scheduleId); }
        removed.push(value.id);
      } catch { console.error('Workflow Occurrence retention failed. Its record and owned work will be retained for retry.'); }
    }
    const retained = new Set(this.historyBySchedule.keys());
    for (const schedule of this.listSchedules(true)) {
      if (this.unknownOccurrences || schedule.deletedAt === undefined || retained.has(schedule.id) || schedule.deletedAt > now - SCHEDULE_RETENTION_MS) continue;
      try {
        rmSync(this.schedulePath(schedule.id)); sync(dirname(this.schedulePath(schedule.id)));
        this.schedules.delete(schedule.id);
      } catch { console.error('Workflow Schedule retention failed. Its record will be retained for retry.'); }
    }
    return removed;
  }
}
