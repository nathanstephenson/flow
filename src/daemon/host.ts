import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendSession } from "../backend/types.ts";
import type { Command, SendWhen, SessionStatus, SessionSummary } from "../protocol/commands.ts";
import type { AgentEvent, BackendEvent, Capabilities, EffortLevel, LoggedEvent } from "../protocol/events.ts";
import { SessionLog } from "./log.ts";
import type { SessionMeta, TranscriptStore } from "./store.ts";

type SessionRecord = {
  id: string;
  scope: string;
  backendName: string;
  log: SessionLog;
  session: BackendSession | undefined;
  status: SessionStatus;
  /**
   * Set by the host the moment it dispatches, not when the backend reports `turn_started`. A
   * backend may take a tick to acknowledge, and in that window a second `after_turn` send would
   * otherwise see an idle session and jump the queue.
   */
  turnInFlight: boolean;
  /**
   * Events an adapter emits while its Backend Session is still being created, held back so the
   * transcript opens with session_started (or revived) rather than with whatever the adapter
   * announced on its way up — the model in force, its capabilities.
   */
  buffered: BackendEvent[] | undefined;
  queue: string[];
  title: string;
  capabilities: Capabilities | undefined;
  resumeToken: string | undefined;
  modelId: string | undefined;
  effort: EffortLevel | undefined;
  createdAt: string;
  updatedAt: string;
};

export type SessionHostOptions = {
  store?: TranscriptStore;
  /**
   * How long a Settled Agent Session survives before it is reaped, in milliseconds. `"never"`
   * disables reaping; omitted means the same, so a host built without a retention policy never
   * deletes anything (ADR 0006).
   *
   * A function is read at each sweep rather than copied in once, which is how an edit to the
   * Settings applies to a daemon that has been up for a week. The daemon passes `ConfigStore`'s
   * `retention` for exactly that; a literal is the convenience the tests use.
   */
  retention?: number | "never" | (() => number | "never");
};

/** Owns every Agent Session, and the Steering Queue that sits above all backends (ADR 0002). */
export class SessionHost {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly backends = new Map<string, AgentBackend>();
  private readonly store: TranscriptStore | undefined;
  private readonly retention: number | "never" | (() => number | "never");
  private readonly closedListeners = new Set<(sessionId: string) => void>();

  constructor(options: SessionHostOptions = {}) {
    this.store = options.store;
    this.retention = options.retention ?? "never";
  }

  /**
   * Notified when an Agent Session stops being something its owner is working in — Settled, Ended
   * or Reaped. Dormant is deliberately not one of these: it says the Backend Session went away, not
   * that the reader did.
   *
   * An observer rather than a direct call into the Shells, so the host stays ignorant that Shells
   * exist. It owns Agent Sessions; what else hangs off one is not its business.
   */
  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  private announceClosed(sessionId: string): void {
    for (const listener of this.closedListeners) listener(sessionId);
  }

  registerBackend(backend: AgentBackend): void {
    this.backends.set(backend.name, backend);
  }

  backendNames(): string[] {
    return [...this.backends.keys()];
  }

  logFor(sessionId: string): SessionLog {
    return this.record(sessionId).log;
  }

  statusOf(sessionId: string): SessionStatus {
    return this.record(sessionId).status;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((record) => ({
        id: record.id,
        scope: record.scope,
        backend: record.backendName,
        status: record.status,
        title: record.title,
        updatedAt: record.updatedAt,
        lastSeq: record.log.lastSeq,
        ...(record.capabilities ? { capabilities: record.capabilities } : {}),
      }))
      // Settled Agent Sessions sink to the bottom: they are the ones their owner is done with, and
      // they would otherwise sort to the top, since settling is itself the most recent activity.
      .sort((left, right) => {
        const settled = Number(left.status === "settled") - Number(right.status === "settled");
        return settled !== 0 ? settled : right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  /**
   * Load previously persisted Agent Sessions as Dormant (ADR 0003): transcripts readable, nothing
   * running, no money spent until someone asks.
   */
  async load(): Promise<void> {
    if (!this.store) return;
    for (const id of await this.store.listSessionIds()) {
      const meta = this.store.readMeta(id);
      if (!meta || this.sessions.has(id)) continue;

      const entries = this.store.readEntries(id);
      const record: SessionRecord = {
        id: meta.id,
        scope: meta.scope,
        backendName: meta.backend,
        log: this.newLog(meta.id, entries),
        session: undefined,
        status: meta.status === "ended" || meta.status === "settled" ? meta.status : "dormant",
        turnInFlight: false,
        buffered: undefined,
        queue: [],
        title: meta.title,
        capabilities: capabilitiesFrom(entries),
        resumeToken: meta.resumeToken,
        modelId: meta.modelId,
        effort: meta.effort,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      };
      this.sessions.set(id, record);
      this.closeTornTurn(record, entries);
      // Dormancy has to be visible to a client reducing the transcript, or a session with nothing
      // running still looks ready to type at. A clean shutdown already recorded it.
      if (record.status === "dormant" && lastEventType(record.log.since(0)) !== "session_dormant") {
        record.log.append({ type: "session_dormant", reason: "host restarted" });
      }
      this.persist(record);
    }
    this.reap();
  }

  async create(options: {
    scope: string;
    backend: string;
    modelId?: string;
    effort?: EffortLevel;
  }): Promise<string> {
    const backend = this.backendFor(options.backend);
    const id = randomUUID();
    const now = new Date().toISOString();

    const record: SessionRecord = {
      id,
      scope: options.scope,
      backendName: backend.name,
      log: this.newLog(id),
      session: undefined,
      status: "idle",
      turnInFlight: false,
      buffered: undefined,
      queue: [],
      title: options.scope,
      capabilities: undefined,
      resumeToken: undefined,
      modelId: options.modelId,
      effort: options.effort,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, record);
    this.persist(record);

    record.buffered = [];
    const session = await this.startBackendSession(record);
    record.log.append({
      type: "session_started",
      backend: backend.name,
      scope: options.scope,
      capabilities: session.capabilities,
    });
    this.flushBuffered(record);
    return id;
  }

  /** Attach a fresh Backend Session to a Dormant Agent Session, continuing the same transcript. */
  async revive(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    if (record.session) return;
    if (record.status === "ended") throw new Error(`Session ${sessionId} has ended`);

    const fromSeq = record.log.lastSeq;
    record.buffered = [];
    await this.startBackendSession(record);
    record.status = "idle";
    record.log.append({ type: "revived", fromSeq });
    this.flushBuffered(record);
  }

  /**
   * `when` is required rather than defaulted. A default of "now" would hand the next caller the one
   * value that can bypass the Steering Queue, and "after_turn" already means "queue if busy, else
   * dispatch now" — so there is no sensible default to pick. It matches `Command` either way.
   */
  async send(sessionId: string, text: string, when: SendWhen): Promise<void> {
    const record = this.record(sessionId);
    // ADR 0003: the first message revives a Dormant session, so resuming work is one action.
    if (!record.session) await this.revive(sessionId);

    if (when === "after_turn" && record.turnInFlight) {
      record.queue.push(text);
      record.log.append({ type: "queue_changed", pending: [...record.queue] });
      this.touch(record);
      return;
    }
    await this.dispatch(record, text);
  }

  async abort(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    // Aborting means stop, not stop-then-continue: queued follow-ups go too.
    if (record.queue.length > 0) {
      record.queue.length = 0;
      record.log.append({ type: "queue_changed", pending: [] });
    }
    await record.session?.abort();
    this.touch(record);
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const record = this.record(sessionId);
    await record.session?.setModel(modelId);
    record.modelId = modelId;
    this.touch(record);
  }

  async setEffort(sessionId: string, effort: EffortLevel): Promise<void> {
    const record = this.record(sessionId);
    await record.session?.setEffort(effort);
    // Remembered as asked for, not as clamped: a Revive onto a model that can serve it should.
    record.effort = effort;
    this.touch(record);
  }

  async dispose(sessionId: string, reason = "disposed"): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const session = record.session;
    record.session = undefined;
    record.status = "ended";
    record.queue.length = 0;
    await session?.dispose();
    record.log.append({ type: "session_ended", reason });
    this.touch(record);
    this.announceClosed(sessionId);
  }

  /**
   * Settle an Agent Session: the engineer declaring they are done with it.
   *
   * The Backend Session stops and the retention clock starts, but unlike `dispose` this is not
   * terminal — the transcript stays readable and a Revive (or the next message) un-settles it.
   * That reversibility is the point: a Settle you regret in the morning is recoverable, while one
   * you forget about is reaped (ADR 0006).
   */
  async settle(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    if (record.status === "ended") throw new Error(`Session ${sessionId} has ended`);
    if (record.status === "settled") return;

    const session = record.session;
    record.session = undefined;
    record.status = "settled";
    record.queue.length = 0;
    record.turnInFlight = false;
    await session?.dispose();
    // Close a turn we are interrupting before recording the Settle. Leaving it open would let the
    // restart path close it *after* session_settled, and a trailing turn_ended reduces to idle —
    // the rail would say settled while the pane said idle.
    const openTurn = openTurnId(record.log.since(0));
    if (openTurn) record.log.append({ type: "turn_ended", turnId: openTurn, reason: "aborted" });
    record.log.append({ type: "session_settled" });
    // Stamps updatedAt, which is what starts the retention clock: a Settled Agent Session runs
    // nothing and so records no further activity, and it always gets a full window.
    this.touch(record);
    this.announceClosed(sessionId);
  }

  /**
   * Delete Settled Agent Sessions whose retention window has passed. Only Settled ones: no other
   * state is deleted on a rule its owner did not opt into.
   *
   * Takes `now` so it can be tested without waiting, and returns what it removed.
   */
  reap(now = Date.now()): string[] {
    // Asked, not remembered: the Settings own this value and it may have changed since startup.
    const retention = typeof this.retention === "function" ? this.retention() : this.retention;
    if (retention === "never") return [];

    const reaped: string[] = [];
    for (const record of [...this.sessions.values()]) {
      if (record.status !== "settled") continue;
      const settledAt = Date.parse(record.updatedAt);
      // An unreadable timestamp means we cannot know the age; leaving it is the safe failure.
      if (Number.isNaN(settledAt) || now - settledAt < retention) continue;

      record.log.closeSubscribers();
      this.sessions.delete(record.id);
      this.store?.deleteSession(record.id);
      reaped.push(record.id);
    }
    for (const sessionId of reaped) this.announceClosed(sessionId);
    return reaped;
  }

  /** Stop running work without ending the Agent Sessions: they become Dormant and can be revived. */
  async shutdown(): Promise<void> {
    for (const record of this.sessions.values()) {
      if (!record.session) continue;
      const session = record.session;
      record.session = undefined;
      record.status = "dormant";
      record.queue.length = 0;
      record.turnInFlight = false;
      await session.dispose();
      record.log.append({ type: "session_dormant", reason: "host shutdown" });
      this.persist(record);
    }
  }

  async execute(command: Command): Promise<unknown> {
    switch (command.type) {
      case "create":
        return await this.create({
          scope: command.scope,
          backend: command.backend,
          ...(command.modelId === undefined ? {} : { modelId: command.modelId }),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
        });
      case "send":
        return await this.send(command.sessionId, command.text, command.when);
      case "abort":
        return await this.abort(command.sessionId);
      case "revive":
        return await this.revive(command.sessionId);
      case "dispose":
        return await this.dispose(command.sessionId);
      case "settle":
        return await this.settle(command.sessionId);
      case "set_model":
        return await this.setModel(command.sessionId, command.modelId);
      case "set_effort":
        return await this.setEffort(command.sessionId, command.effort);
      case "list":
        return this.list();
    }
  }

  private async startBackendSession(record: SessionRecord): Promise<BackendSession> {
    const backend = this.backendFor(record.backendName);
    const session = await backend.create({
      scope: record.scope,
      emit: (event) => this.onBackendEvent(record.id, event),
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      ...(record.resumeToken === undefined ? {} : { resume: record.resumeToken }),
      ...(this.store ? { stateDir: this.store.backendDir(record.id) } : {}),
    });
    record.session = session;
    record.capabilities = session.capabilities;
    this.captureResumeToken(record);
    return session;
  }

  /**
   * A turn left open by an unclean shutdown is closed on load rather than left hanging. The
   * transcript is append-only (ADR 0001), so we record that we now know it ended instead of
   * rewriting the turn that never finished.
   */
  private closeTornTurn(record: SessionRecord, entries: LoggedEvent[]): void {
    const openTurn = openTurnId(entries);
    if (!openTurn) return;
    record.log.append({ type: "turn_ended", turnId: openTurn, reason: "aborted" });
  }

  private async dispatch(record: SessionRecord, text: string): Promise<void> {
    if (!record.session) throw new Error(`Session ${record.id} has no Backend Session`);
    record.turnInFlight = true;
    record.status = "running";
    record.log.append({ type: "user_message", id: randomUUID(), text });
    if (record.title === record.scope) record.title = firstLine(text);
    this.touch(record);
    await record.session.prompt(text);
  }

  private flushBuffered(record: SessionRecord): void {
    const buffered = record.buffered ?? [];
    record.buffered = undefined;
    for (const event of buffered) this.onBackendEvent(record.id, event);
  }

  private onBackendEvent(sessionId: string, event: BackendEvent): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.status === "ended" || record.status === "settled") return;
    if (record.buffered) {
      record.buffered.push(event);
      return;
    }

    record.log.append(event);
    this.touch(record);

    if (event.type === "turn_ended") {
      record.turnInFlight = false;
      record.status = "idle";
      this.captureResumeToken(record);
      void this.drain(record);
    }
  }

  private captureResumeToken(record: SessionRecord): void {
    const token = record.session?.resumeToken();
    if (token && token !== record.resumeToken) {
      record.resumeToken = token;
      this.persist(record);
    }
  }

  private async drain(record: SessionRecord): Promise<void> {
    const next = record.queue.shift();
    if (next === undefined) return;
    record.log.append({ type: "queue_changed", pending: [...record.queue] });
    try {
      await this.dispatch(record, next);
    } catch (error) {
      record.log.append({ type: "notice", level: "error", text: errorMessage(error) });
    }
  }

  private newLog(sessionId: string, existing?: LoggedEvent[]): SessionLog {
    const store = this.store;
    return new SessionLog(sessionId, {
      ...(existing ? { existing } : {}),
      ...(store ? { sink: (entry) => store.append(entry) } : {}),
    });
  }

  private backendFor(name: string): AgentBackend {
    const backend = this.backends.get(name);
    if (!backend) throw new Error(`Unknown backend: ${name}`);
    return backend;
  }

  private record(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    return record;
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = new Date().toISOString();
    this.persist(record);
  }

  private persist(record: SessionRecord): void {
    if (!this.store) return;
    const meta: SessionMeta = {
      id: record.id,
      scope: record.scope,
      backend: record.backendName,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      ...(record.resumeToken === undefined ? {} : { resumeToken: record.resumeToken }),
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.effort === undefined ? {} : { effort: record.effort }),
    };
    this.store.writeMeta(meta);
  }
}

/** The turn still open at the end of these entries, if any. */
function openTurnId(entries: LoggedEvent[]): string | undefined {
  let openTurn: string | undefined;
  for (const entry of entries) {
    if (entry.event.type === "turn_started") openTurn = entry.event.turnId;
    if (entry.event.type === "turn_ended") openTurn = undefined;
  }
  return openTurn;
}

function lastEventType(entries: LoggedEvent[]): string | undefined {
  return entries.at(-1)?.event.type;
}

function capabilitiesFrom(entries: LoggedEvent[]): Capabilities | undefined {
  let capabilities: Capabilities | undefined;
  for (const entry of entries) {
    const event: AgentEvent = entry.event;
    if (event.type === "session_started" || event.type === "capabilities_changed") {
      capabilities = event.capabilities;
    }
  }
  return capabilities;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Untitled session";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
