import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendSession } from "../backend/types.ts";
import type { Command, SendWhen, SessionStatus, SessionSummary } from "../protocol/commands.ts";
import type { AgentEvent, BackendEvent, Capabilities, LoggedEvent } from "../protocol/events.ts";
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
  queue: string[];
  title: string;
  capabilities: Capabilities | undefined;
  resumeToken: string | undefined;
  modelId: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type SessionHostOptions = {
  store?: TranscriptStore;
};

/** Owns every Agent Session, and the Steering Queue that sits above all backends (ADR 0002). */
export class SessionHost {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly backends = new Map<string, AgentBackend>();
  private readonly store: TranscriptStore | undefined;

  constructor(options: SessionHostOptions = {}) {
    this.store = options.store;
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
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
        status: meta.status === "ended" ? "ended" : "dormant",
        turnInFlight: false,
        queue: [],
        title: meta.title,
        capabilities: capabilitiesFrom(entries),
        resumeToken: meta.resumeToken,
        modelId: meta.modelId,
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
  }

  async create(options: { scope: string; backend: string; modelId?: string }): Promise<string> {
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
      queue: [],
      title: options.scope,
      capabilities: undefined,
      resumeToken: undefined,
      modelId: options.modelId,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, record);
    this.persist(record);

    const session = await this.startBackendSession(record);
    record.log.append({
      type: "session_started",
      backend: backend.name,
      scope: options.scope,
      capabilities: session.capabilities,
    });
    return id;
  }

  /** Attach a fresh Backend Session to a Dormant Agent Session, continuing the same transcript. */
  async revive(sessionId: string): Promise<void> {
    const record = this.record(sessionId);
    if (record.session) return;
    if (record.status === "ended") throw new Error(`Session ${sessionId} has ended`);

    const fromSeq = record.log.lastSeq;
    await this.startBackendSession(record);
    record.status = "idle";
    record.log.append({ type: "revived", fromSeq });
  }

  async send(sessionId: string, text: string, when: SendWhen = "now"): Promise<void> {
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
        });
      case "send":
        return await this.send(command.sessionId, command.text, command.when);
      case "abort":
        return await this.abort(command.sessionId);
      case "revive":
        return await this.revive(command.sessionId);
      case "dispose":
        return await this.dispose(command.sessionId);
      case "set_model":
        return await this.setModel(command.sessionId, command.modelId);
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
    let openTurn: string | undefined;
    for (const entry of entries) {
      if (entry.event.type === "turn_started") openTurn = entry.event.turnId;
      if (entry.event.type === "turn_ended") openTurn = undefined;
    }
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

  private onBackendEvent(sessionId: string, event: BackendEvent): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.status === "ended") return;

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
    };
    this.store.writeMeta(meta);
  }
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
