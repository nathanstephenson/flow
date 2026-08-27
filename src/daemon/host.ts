import { randomUUID } from "node:crypto";

import type { AgentBackend, BackendSession } from "../backend/types.ts";
import type { Command, SendWhen, SessionStatus, SessionSummary } from "../protocol/commands.ts";
import type { BackendEvent, Capabilities } from "../protocol/events.ts";
import { SessionLog } from "./log.ts";

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
  updatedAt: string;
};

const EMPTY_CAPABILITIES: Capabilities = { providers: [], models: [], compaction: false, fork: false };

/** Owns every Agent Session, and the Steering Queue that sits above all backends (ADR 0002). */
export class SessionHost {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly backends = new Map<string, AgentBackend>();

  registerBackend(backend: AgentBackend): void {
    this.backends.set(backend.name, backend);
  }

  backendNames(): string[] {
    return [...this.backends.keys()];
  }

  logFor(sessionId: string): SessionLog {
    return this.record(sessionId).log;
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

  async create(options: { scope: string; backend: string; modelId?: string }): Promise<string> {
    const backend = this.backends.get(options.backend);
    if (!backend) throw new Error(`Unknown backend: ${options.backend}`);

    const id = randomUUID();
    const record: SessionRecord = {
      id,
      scope: options.scope,
      backendName: backend.name,
      log: new SessionLog(id),
      session: undefined,
      status: "idle",
      turnInFlight: false,
      queue: [],
      title: options.scope,
      capabilities: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, record);

    const session = await backend.create({
      scope: options.scope,
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      emit: (event) => this.onBackendEvent(id, event),
    });

    record.session = session;
    record.capabilities = session.capabilities;
    record.log.append({
      type: "session_started",
      backend: backend.name,
      scope: options.scope,
      capabilities: session.capabilities,
    });
    return id;
  }

  async send(sessionId: string, text: string, when: SendWhen = "now"): Promise<void> {
    const record = this.record(sessionId);
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

  async disposeAll(reason = "shutdown"): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id, reason)));
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
      case "dispose":
        return await this.dispose(command.sessionId);
      case "set_model":
        return await this.setModel(command.sessionId, command.modelId);
      case "list":
        return this.list();
      case "revive":
        throw new Error("Revive arrives with durability in M2");
    }
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
      void this.drain(record);
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

  private record(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    return record;
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = new Date().toISOString();
  }
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Untitled session";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { EMPTY_CAPABILITIES };
