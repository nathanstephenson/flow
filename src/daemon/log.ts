import type { AgentEvent, LoggedEvent } from "../protocol/events.ts";

export type LogListener = (entry: LoggedEvent) => void;

/**
 * A Presentation Transcript: append-only, sequence-numbered, never rewritten (ADR 0001).
 *
 * Every transcript write in GoodHarness goes through this module. Keeping it in one place is what
 * makes a different storage backing a local change later rather than a sweep.
 */
export class SessionLog {
  readonly sessionId: string;

  private readonly entries: LoggedEvent[] = [];
  private readonly listeners = new Set<LogListener>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get lastSeq(): number {
    return this.entries.length;
  }

  append(event: AgentEvent, at = new Date().toISOString()): LoggedEvent {
    const entry: LoggedEvent = { seq: this.entries.length + 1, sessionId: this.sessionId, at, event };
    this.entries.push(entry);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  /** Entries after `seq`. `since(0)` is the whole transcript, which makes reconnect a replay. */
  since(seq: number): LoggedEvent[] {
    return seq <= 0 ? [...this.entries] : this.entries.slice(seq);
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
