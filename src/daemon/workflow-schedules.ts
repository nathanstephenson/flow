import type { WorkflowExecution } from '../protocol/workflows.ts';
import { ScheduleValidationError } from '../workflows/schedule-errors.ts';
import type { WorkflowOccurrence, WorkflowSchedule, WorkflowScheduleSettings } from '../protocol/workflow-schedules.ts';
import { WorkflowScheduleStore, ScheduleRecordNotFound, ScheduleRevisionConflict } from '../workflows/schedule-store.ts';
import { advancePast, createSchedule, editSchedule, isActiveOccurrence, LIVE_DISPATCH_TOLERANCE_MS, nextOccurrence, occurrenceId, occurrenceSettings, projectExecution } from '../workflows/schedules.ts';

export class ScheduledExecutionStarted extends Error {
  readonly executionId: string;
  constructor(executionId: string, options: ErrorOptions) {
    super('Scheduled execution requires reconciliation', options);
    this.executionId = executionId;
  }
}

export interface ScheduleDriver {
  validate(settings: WorkflowScheduleSettings): Promise<void>;
  launch(occurrence: WorkflowOccurrence, signal?: AbortSignal): Promise<void>;
  current?(occurrence: WorkflowOccurrence): WorkflowExecution | undefined;
  reconcile(occurrence: WorkflowOccurrence): Promise<void>;
  cancel(occurrence: WorkflowOccurrence): Promise<void>;
  cleanup(occurrence: WorkflowOccurrence): Promise<void>;
  cleanupUnstarted?(occurrence: WorkflowOccurrence): Promise<void>;
}
export class WorkflowScheduleService {
  readonly store: WorkflowScheduleStore;
  private readonly driver: ScheduleDriver;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly launches = new Map<string, { done: Promise<void>; controller: AbortController }>();
  private readonly pendingUpdates = new Map<string, WorkflowOccurrence>();
  private readonly occurrenceQueues = new Map<string, Promise<unknown>>();
  private readonly reconciliations = new Set<string>();
  private readonly startupMisses = new Map<string, string>();
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly cleanups = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  constructor(store: WorkflowScheduleStore, driver: ScheduleDriver, now = Date.now) {
    this.store = store; this.driver = driver; this.now = now;
    store.setOccurrenceProjection(occurrence => this.project(occurrence));
  }
  private project(occurrence: WorkflowOccurrence): WorkflowOccurrence {
    const pending = this.pendingUpdates.get(occurrence.id);
    const saved = structuredClone(pending ? { ...occurrence, status: pending.status,
      ...(!occurrence.executionId && pending.executionId ? { executionId: pending.executionId } : {}),
      ...(!occurrence.sessionId && pending.sessionId ? { sessionId: pending.sessionId } : {}),
      ...(pending.finishedAt === undefined ? {} : { finishedAt: pending.finishedAt }),
      ...(pending.outcome === undefined ? {} : { outcome: pending.outcome }) } : occurrence);
    try {
      const execution = this.driver.current?.(saved);
      return execution ? projectExecution(saved, execution, this.now()) : saved;
    } catch {
      console.error('Workflow Occurrence checkpoint is unavailable. Its durable state will be retained for reconciliation.');
      return saved;
    }
  }
  private persist(occurrence: WorkflowOccurrence): void {
    if (!isActiveOccurrence(this.store.getStoredOccurrence(occurrence.id))) {
      this.pendingUpdates.delete(occurrence.id); return;
    }
    this.pendingUpdates.set(occurrence.id, occurrence);
    try { this.store.saveOccurrence(occurrence); }
    catch (error) {
      if (isActiveOccurrence(this.store.getStoredOccurrence(occurrence.id))) throw error;
    }
    this.pendingUpdates.delete(occurrence.id);
  }
  private flushPending(): boolean {
    let failed = false;
    for (const occurrence of this.pendingUpdates.values()) {
      try {
        const saved = this.store.getStoredOccurrence(occurrence.id);
        if (!isActiveOccurrence(saved)) this.pendingUpdates.delete(occurrence.id);
        else if (!this.occurrenceQueues.has(occurrence.id)) this.persist(this.project(saved));
      } catch (error) {
        if (error instanceof ScheduleRecordNotFound) { this.pendingUpdates.delete(occurrence.id); continue; }
        failed = true;
        console.error('Workflow Occurrence status could not be saved. Its pending update will be retained for retry.');
      }
    }
    return failed;
  }
  private forOccurrence<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.occurrenceQueues.get(id) ?? Promise.resolve()).then(run);
    const tail = next.catch(() => {}).finally(() => { if (this.occurrenceQueues.get(id) === tail) this.occurrenceQueues.delete(id); });
    this.occurrenceQueues.set(id, tail);
    return next;
  }
  private reconcilePending(): Promise<void> {
    return Promise.all([...this.reconciliations].map(id => {
      const existing = this.reconciling.get(id);
      if (existing) return existing;
      const done = this.forOccurrence(id, async () => {
        try {
          const occurrence = this.store.getOccurrence(id);
          if (isActiveOccurrence(occurrence)) await this.driver.reconcile(occurrence);
          this.reconciliations.delete(id);
        } catch { console.error('Workflow Occurrence reconciliation failed. Durable work will be retained for retry without replay.'); }
      }).finally(() => { this.reconciling.delete(id); });
      this.reconciling.set(id, done);
      return done;
    })).then(() => {});
  }
  private sweepUnstartedCleanup(): void {
    if (!this.driver.cleanupUnstarted) return;
    for (const id of this.store.pendingUnstartedCleanup()) {
      if (this.cleanups.has(id)) continue;
      const done = this.forOccurrence(id, async () => {
        try {
          const occurrence = this.store.getStoredOccurrence(id);
          if (isActiveOccurrence(occurrence)) return;
          this.store.prepareUnstartedCleanup(id);
          await this.driver.cleanupUnstarted!(occurrence);
          this.store.completeUnstartedCleanup(id);
        } catch (error) {
          if (!(error instanceof ScheduleRecordNotFound)) console.error('Workflow Occurrence resource cleanup failed. Its journal and owned work will be retained for retry.');
        }
      }).finally(() => { this.cleanups.delete(id); });
      this.cleanups.set(id, done);
    }
  }
  private serial<T>(run: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => {}); return next;
  }
  async start(timers = true): Promise<void> {
    for (const occurrence of this.store.listActiveOccurrences()) this.reconciliations.add(occurrence.id);
    await this.reconcilePending();
    await this.serial(() => {
      this.stopped = false;
      try { this.dispatch(true); }
      catch { console.error('Workflow Schedule startup admission failed. The Session Host will retry.'); }
    });
    this.sweepUnstartedCleanup();
    if (timers) this.arm();
  }
  private arm(retryDelay?: number): void {
    if (this.stopped) return;
    const due = Math.min(...this.store.listSchedules().flatMap(schedule => schedule.nextDue === undefined ? [] : [schedule.nextDue]));
    const delay = retryDelay ?? Math.max(1, Math.min(30_000, due - this.now()));
    this.timer = setTimeout(() => {
      void this.tick().then(() => this.arm(), () => {
        console.error('Workflow Schedule admission failed. The Session Host will retry.');
        this.arm(1000);
      });
    }, delay);
    this.timer.unref();
  }
  tick(): Promise<void> {
    return this.serial(() => { if (!this.stopped) this.dispatch(false); }).finally(() => {
      if (!this.stopped) { void this.reconcilePending(); this.sweepUnstartedCleanup(); }
    });
  }
  private dispatch(startup: boolean): void {
    let failed = this.flushPending();
    for (const schedule of this.store.listSchedules()) {
      try { this.admit(schedule, startup); } catch { failed = true; }
    }
    if (failed) throw new Error('Workflow Schedule admission failed');
  }
  private admit(schedule: WorkflowSchedule, startup: boolean): void {
    const now = this.now(), due = schedule.nextDue;
    if (!schedule.enabled || due === undefined || due > now) return;
    const id = occurrenceId(schedule.id, schedule.activation, due);
    if (startup) this.startupMisses.set(schedule.id, id);
    const missed = startup || this.startupMisses.get(schedule.id) === id || now - due > LIVE_DISPATCH_TOLERANCE_MS;
    const next = advancePast(schedule.timing, due, now);
    const active = this.store.activeCount(schedule.id);
    const status = missed ? 'missed' : active >= schedule.concurrency ? 'capacity-skipped' : 'provisioning';
    const occurrence: WorkflowOccurrence = { version: 1, id, scheduleId: schedule.id, activation: schedule.activation, revision: schedule.revision, scheduledAt: due,
      settings: occurrenceSettings(schedule), status, createdAt: now,
      ...(missed ? { missedThrough: now } : {}), ...(status === 'provisioning' ? {} : { finishedAt: now }) };
    const claimed = this.store.claimOccurrence(occurrence);
    try { this.store.advanceCursor(schedule.id, schedule.revision, due, next); }
    catch (error) {
      if (claimed && status === 'provisioning') this.interruptClaim(occurrence);
      throw error;
    }
    this.startupMisses.delete(schedule.id);
    if (!claimed) {
      const saved = this.store.getOccurrence(occurrence.id);
      if (saved.status === 'provisioning' && !this.launches.has(saved.id) && !this.reconciliations.has(saved.id) && !this.occurrenceQueues.has(saved.id) && !this.driver.current?.(saved)) this.interruptClaim(saved);
      return;
    }
    if (status !== 'provisioning') return;
    const controller = new AbortController();
    const done = this.forOccurrence(occurrence.id, () => this.launch(occurrence, controller.signal))
      .catch(() => { console.error('Workflow Occurrence status could not be saved. Its durable claim or execution will be retained.'); })
      .finally(() => { this.launches.delete(occurrence.id); this.sweepUnstartedCleanup(); });
    this.launches.set(occurrence.id, { done, controller });
  }
  private interruptClaim(occurrence: WorkflowOccurrence): void {
    this.persist({ ...occurrence, status: 'interrupted', finishedAt: this.now(), outcome: 'Admission stopped before provisioning. This occurrence will not be replayed.' });
  }
  private async launch(occurrence: WorkflowOccurrence, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const current = this.store.getSchedule(occurrence.scheduleId);
      if (this.stopped || !current.enabled || current.revision !== occurrence.revision || current.activation !== occurrence.activation) {
        this.interruptClaim(occurrence); return;
      }
      await this.driver.launch(occurrence, signal);
    } catch (error) {
      const saved = this.store.getOccurrence(occurrence.id);
      const execution = this.driver.current?.(saved);
      if (execution) { this.result(execution); return; }
      if (error instanceof ScheduledExecutionStarted) {
        this.persist({ ...saved, executionId: error.executionId, status: 'recovery-required', outcome: 'Launch bookkeeping failed after execution started; effects may have occurred. Recovery is required.' });
      } else if (saved.status === 'provisioning') {
        this.persist({ ...saved, status: signal.aborted ? (this.stopped ? 'interrupted' : 'cancelled') : 'launch-failed', finishedAt: this.now(),
          outcome: signal.aborted ? 'Provisioning stopped before execution.' : 'Scheduled launch failed validation or provisioning. Check the saved workflow, Project, runtime and MCP configuration.' });
      }
    }
  }
  async create(settings: WorkflowScheduleSettings, enabled: boolean): Promise<WorkflowSchedule> {
    await this.driver.validate(settings);
    return this.serial(() => { const saved = createSchedule(settings, this.now(), enabled); this.store.saveSchedule(saved); return saved; });
  }
  async update(id: string, revision: number, settings: WorkflowScheduleSettings, enabled: boolean): Promise<WorkflowSchedule> {
    await this.driver.validate(settings);
    return this.serial(() => {
      const current = this.store.getSchedule(id);
      if (current.revision !== revision) throw new ScheduleRevisionConflict();
      const saved = editSchedule(current, settings, enabled, this.now());
      this.store.saveSchedule(saved, revision); return saved;
    });
  }
  pause(id: string, revision: number): Promise<WorkflowSchedule> {
    return this.serial(() => {
      const current = this.store.getSchedule(id);
      if (current.revision !== revision) throw new ScheduleRevisionConflict();
      const saved = editSchedule(current, occurrenceSettings(current), false, this.now());
      this.store.saveSchedule(saved, revision); return saved;
    });
  }
  delete(id: string, revision: number): Promise<void> { return this.serial(() => this.store.deleteSchedule(id, revision, this.now())); }
  preview(settings: WorkflowScheduleSettings): number { return nextOccurrence(settings.timing, this.now()); }
  retryAttachment(id: string): Promise<void> {
    return this.forOccurrence(id, async () => {
      const occurrence = this.store.getOccurrence(id);
      if (occurrence.status !== 'recovery-required' || occurrence.association !== 'failed') throw new ScheduleValidationError('Attachment is not available');
      try { await this.driver.reconcile(occurrence); this.reconciliations.delete(id); }
      catch { throw new Error('Workflow Occurrence attachment failed. Durable work has been retained.'); }
    });
  }
  cancel(id: string): Promise<void> {
    this.launches.get(id)?.controller.abort();
    return this.forOccurrence(id, async () => {
      const occurrence = this.store.getOccurrence(id);
      try { await this.driver.cancel(occurrence); this.reconciliations.delete(id); }
      catch { throw new Error('Workflow Occurrence cancellation failed. Durable work has been retained.'); }
    }).finally(() => this.sweepUnstartedCleanup());
  }
  async prune(): Promise<string[]> {
    await this.serial(() => { this.flushPending(); });
    this.sweepUnstartedCleanup();
    return this.store.prune(this.now(), occurrence => this.forOccurrence(occurrence.id, () => this.driver.cleanup(occurrence)), id => !this.occurrenceQueues.has(id));
  }
  hasActiveWork(): boolean { return this.launches.size > 0 || this.store.activeCount() > 0; }
  async stopAdmission(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    for (const launch of this.launches.values()) launch.controller.abort();
    await this.queue;
    await Promise.all([...this.launches.values()].map(launch => launch.done));
    while (this.occurrenceQueues.size || this.reconciling.size || this.cleanups.size) {
      await Promise.all([...this.occurrenceQueues.values(), ...this.reconciling.values(), ...this.cleanups.values()]);
    }
  }
  result(record: WorkflowExecution): void {
    if (!record.occurrenceId) return;
    const durable = this.store.getStoredOccurrence(record.occurrenceId);
    if (!isActiveOccurrence(durable)) { this.pendingUpdates.delete(durable.id); return; }
    const saved = this.project(durable), projected = projectExecution(saved, this.driver.current?.(saved) ?? record, this.now());
    if (this.occurrenceQueues.has(saved.id)) this.pendingUpdates.set(saved.id, projected);
    else this.persist(projected);
  }
}
