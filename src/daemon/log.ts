import type { AgentEvent, LoggedEvent } from "../protocol/events.ts";
import { initialState, reduce, type Entry, type ViewState } from "../client/reduce.ts";
import { OutcomeProvenance } from "../protocol/presentation.ts";
import type { IndexedEntry, PresentationPage, PresentationSnapshot, PresentationState, PresentationUpdate } from "../protocol/presentation.ts";

export type LogListener = (entry: LoggedEvent) => void;
export type PresentationListener = (update: PresentationUpdate) => void;

/**
 * A Presentation Transcript: append-only, sequence-numbered, never rewritten (ADR 0001).
 *
 * Every transcript write in Flow goes through this module. Keeping it in one place is what
 * makes a different storage backing a local change later rather than a sweep.
 */
export class SessionLog {
  readonly sessionId: string;

  private readonly entries: LoggedEvent[];
  private readonly listeners = new Set<LogListener>();
  private readonly sink: LogListener | undefined;
  // Never reduced until a reader asks. Once viewed, appends keep this full-log projection current.
  private presentation: ViewState | undefined;
  private readonly outcomes = new OutcomeProvenance();
  private readonly presentationListeners = new Set<PresentationListener>();

  constructor(sessionId: string, options: { sink?: LogListener; existing?: LoggedEvent[] } = {}) {
    this.sessionId = sessionId;
    this.entries = options.existing ? [...options.existing] : [];
    this.sink = options.sink;
  }

  get lastSeq(): number {
    return this.entries.length;
  }

  append(event: AgentEvent, at = new Date().toISOString()): LoggedEvent {
    const entry: LoggedEvent = { seq: this.entries.length + 1, sessionId: this.sessionId, at, event };
    this.entries.push(entry);
    // Durable before observable: a client must never see an event that a restart would lose.
    this.sink?.(entry);
    let update: PresentationUpdate | undefined;
    if (this.presentation) {
      const previous = this.presentation;
      this.presentation = reduce(previous, entry);
      const proofChanges = new Set(this.outcomes.advance(entry, previous.entries, this.presentation.entries));
      if (this.presentationListeners.size > 0) {
        const state = metadata(this.presentation);
        const oldState = metadata(previous);
        const changed = (Object.keys({ ...oldState, ...state }) as (keyof PresentationState)[])
          .some(key => oldState[key] !== state[key]);
        update = {
          type: "update", seq: entry.seq, total: this.presentation.entries.length,
          entries: this.presentation.entries.flatMap((item, index) =>
            item === previous.entries[index] && !proofChanges.has(index) ? [] : [this.indexed(index, item)]),
          ...(changed ? { state } : {}),
        };
      }
    }
    // Both channels see the updated projection, even if a raw listener reads it synchronously.
    for (const listener of this.listeners) listener(entry);
    if (update) for (const listener of this.presentationListeners) listener(update);
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

  /** Full current suffix on reconnect; the limit applies only when no start is supplied. */
  presentationSnapshot(start?: number, limit = 400): PresentationSnapshot {
    validateLimit(limit);
    const view = this.presentationView();
    const total = view.entries.length;
    const first = start ?? Math.max(0, total - limit);
    validateOrdinal(first, total);
    const related: IndexedEntry[] = [];
    for (let index = 0; index < first; index++) {
      const item = view.entries[index]!;
      if (item.kind === "subagent" || item.kind === "background_call" ||
          (item.kind === "tool" && (item.authorisation === "asked" || item.id === view.authorising?.callId)) ||
          (item.kind === "enquiry" && item.status === "asked")) {
        related.push(this.indexed(index, item));
      }
    }
    return {
      type: "snapshot", seq: this.lastSeq, state: metadata(view),
      entries: this.indexedRange(view.entries, first, total), related, start: first, total,
    };
  }

  /** A backward page, in transcript order, current as of seq. `before` is exclusive. */
  presentationPage(before?: number, limit = 400): PresentationPage {
    validateLimit(limit);
    const view = this.presentationView();
    const total = view.entries.length;
    const end = before ?? total;
    validateOrdinal(end, total);
    const start = Math.max(0, end - limit);
    return { seq: this.lastSeq, entries: this.indexedRange(view.entries, start, end), start, total };
  }

  subscribePresentation(listener: PresentationListener): () => void {
    this.presentationView();
    this.presentationListeners.add(listener);
    return () => this.presentationListeners.delete(listener);
  }

  private presentationView(): ViewState {
    if (!this.presentation) {
      let view = initialState();
      for (const logged of this.entries) {
        const previous = view;
        // Read each stored event once, shared by reduction and provenance derivation.
        const replay = { seq: logged.seq, sessionId: logged.sessionId, at: logged.at, event: logged.event };
        view = reduce(view, replay);
        this.outcomes.advance(replay, previous.entries, view.entries);
      }
      this.presentation = view;
    }
    return this.presentation;
  }

  private indexed(index: number, entry: Entry): IndexedEntry {
    const outcomeSeq = this.outcomes.get(index);
    return { index, entry, ...(outcomeSeq === undefined ? {} : { outcomeSeq }) };
  }

  private indexedRange(entries: Entry[], start: number, end: number): IndexedEntry[] {
    return entries.slice(start, end).map((entry, offset) => this.indexed(start + offset, entry));
  }

  /**
   * Drop every subscriber. Used when an Agent Session is reaped: an open stream to a transcript
   * that no longer exists would otherwise wait forever on a log nothing can append to again.
   */
  closeSubscribers(): void {
    this.listeners.clear();
    this.presentationListeners.clear();
  }
}

function metadata({ entries: _entries, lastSeq: _lastSeq, ...state }: ViewState): PresentationState {
  return state;
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 400) {
    throw new RangeError("limit must be an integer between 1 and 400");
  }
}

function validateOrdinal(ordinal: number, total: number): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > total) {
    throw new RangeError(`ordinal must be an integer between 0 and ${total}`);
  }
}
