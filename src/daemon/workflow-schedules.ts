import type { WorkflowExecution } from '../protocol/workflows.ts';
import type { WorkflowOccurrence, WorkflowSchedule, WorkflowScheduleSettings } from '../protocol/workflow-schedules.ts';
import { WorkflowScheduleStore, ScheduleRevisionConflict } from '../workflows/schedule-store.ts';
import { advancePast, createSchedule, editSchedule, LIVE_DISPATCH_TOLERANCE_MS, nextOccurrence, occurrenceId, occurrenceSettings, projectExecution } from '../workflows/schedules.ts';

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
}
export class WorkflowScheduleService {
  readonly store: WorkflowScheduleStore;
  private readonly driver: ScheduleDriver;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly launches = new Map<string, { done: Promise<void>; controller: AbortController }>();
  private readonly pendingUpdates = new Map<string, WorkflowOccurrence>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  constructor(store: WorkflowScheduleStore, driver: ScheduleDriver, now = Date.now) {
    this.store = store; this.driver = driver; this.now = now;
    store.setOccurrenceProjection(occurrence => this.project(occurrence));
  }
  private project(occurrence: WorkflowOccurrence): WorkflowOccurrence {
    const saved = structuredClone(this.pendingUpdates.get(occurrence.id) ?? occurrence);
    const execution = this.driver.current?.(saved);
    return execution ? projectExecution(saved, execution, this.now()) : saved;
  }
  private persist(occurrence: WorkflowOccurrence): void {
    this.pendingUpdates.set(occurrence.id, occurrence);
    this.store.saveOccurrence(occurrence);
    this.pendingUpdates.delete(occurrence.id);
  }
  private serial<T>(run: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => {}); return next;
  }
  async start(timers = true): Promise<void> {
    await this.serial(async () => {
      for (const occurrence of this.store.listActiveOccurrences()) await this.driver.reconcile(occurrence);
      this.dispatch(true);
      this.stopped = false;
    });
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
  tick(): Promise<void> { return this.serial(() => { if (!this.stopped) this.dispatch(false); }); }
  private dispatch(startup: boolean): void {
    const errors: unknown[] = [];
    for (const occurrence of this.pendingUpdates.values()) {
      try { this.persist(this.project(occurrence)); } catch (error) { errors.push(error); }
    }
    for (const schedule of this.store.listSchedules()) {
      try { this.admit(schedule, startup); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Workflow Schedule admission failed');
  }
  private admit(schedule: WorkflowSchedule, startup: boolean): void {
    const now = this.now(), due = schedule.nextDue;
    if (!schedule.enabled || due === undefined || due > now) return;
    const missed = startup || now - due > LIVE_DISPATCH_TOLERANCE_MS;
    const next = advancePast(schedule.timing, due, now);
    const active = this.store.activeCount(schedule.id);
    const status = missed ? 'missed' : active >= schedule.concurrency ? 'capacity-skipped' : 'provisioning';
    const occurrence: WorkflowOccurrence = { version: 1, id: occurrenceId(schedule.id, schedule.activation, due), scheduleId: schedule.id, activation: schedule.activation, revision: schedule.revision, scheduledAt: due,
      settings: occurrenceSettings(schedule), status, createdAt: now,
      ...(missed ? { missedThrough: now } : {}), ...(status === 'provisioning' ? {} : { finishedAt: now }) };
    const claimed = this.store.claimOccurrence(occurrence);
    try { this.store.advanceCursor(schedule.id, schedule.revision, due, next); }
    catch (error) {
      if (claimed && status === 'provisioning') this.interruptClaim(occurrence);
      throw error;
    }
    if (!claimed) {
      const saved = this.store.getOccurrence(occurrence.id);
      if (saved.status === 'provisioning' && !this.launches.has(saved.id) && !this.driver.current?.(saved)) this.interruptClaim(saved);
      return;
    }
    if (status !== 'provisioning') return;
    const controller = new AbortController();
    const done = Promise.resolve().then(() => this.launch(occurrence, controller.signal))
      .catch(() => { console.error('Workflow Occurrence status could not be saved. Its durable claim or execution will be retained.'); })
      .finally(() => { this.launches.delete(occurrence.id); });
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
  create(settings: WorkflowScheduleSettings, enabled: boolean): Promise<WorkflowSchedule> {
    return this.serial(async () => { await this.driver.validate(settings); const saved = createSchedule(settings, this.now(), enabled); this.store.saveSchedule(saved); return saved; });
  }
  update(id: string, revision: number, settings: WorkflowScheduleSettings, enabled: boolean): Promise<WorkflowSchedule> {
    return this.serial(async () => {
      const current = this.store.getSchedule(id);
      if (current.revision !== revision) throw new ScheduleRevisionConflict();
      await this.driver.validate(settings);
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
  async retryAttachment(id: string): Promise<void> { const occurrence = this.store.getOccurrence(id); if (occurrence.status !== 'recovery-required' || occurrence.association !== 'failed') throw new Error('Attachment is not available'); await this.driver.reconcile(occurrence); }
  async cancel(id: string): Promise<void> {
    const launch = this.launches.get(id);
    launch?.controller.abort();
    await launch?.done;
    await this.driver.cancel(this.store.getOccurrence(id));
  }
  async prune(): Promise<string[]> {
    for (const occurrence of this.pendingUpdates.values()) this.persist(this.project(occurrence));
    return this.store.prune(this.now(), occurrence => this.driver.cleanup(occurrence));
  }
  hasActiveWork(): boolean { return this.launches.size > 0 || this.store.activeCount() > 0; }
  async stopAdmission(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    for (const launch of this.launches.values()) launch.controller.abort();
    await this.queue;
    await Promise.all([...this.launches.values()].map(launch => launch.done));
  }
  result(record: WorkflowExecution): void {
    if (!record.occurrenceId) return;
    const saved = this.store.getOccurrence(record.occurrenceId);
    this.persist(projectExecution(saved, this.driver.current?.(saved) ?? record, this.now()));
  }
}
