import type { Entry, ViewState } from "../client/reduce.ts";
import type { LoggedEvent } from "./events.ts";

/** Zero-based ordinal in the complete reduced Presentation Transcript, not an event sequence. */
export type IndexedEntry = {
  index: number;
  entry: Entry;
  /** Exact raw event boundary whose qualifying outcome this row presents, not its update seq. */
  outcomeSeq?: number;
};

export type PresentationState = Omit<ViewState, "entries" | "lastSeq">;

export type PresentationSnapshot = {
  type: "snapshot";
  seq: number;
  state: PresentationState;
  entries: IndexedEntry[];
  /** Cards and unresolved controls outside the loaded suffix. */
  related: IndexedEntry[];
  start: number;
  total: number;
};

export type PresentationUpdate = {
  type: "update";
  seq: number;
  /** Complete metadata replacement, present only when a shallow field changed. */
  state?: PresentationState;
  /** Changed or new entries, including updates outside the loaded suffix. */
  entries: IndexedEntry[];
  total: number;
};

export type PresentationPage = {
  seq: number;
  entries: IndexedEntry[];
  start: number;
  total: number;
};

/**
 * Derived alongside the full reducer, never from a bounded tail. One latest boundary per row keeps
 * proof bounded by the reduced transcript. Shared with raw-replay clients so both transports agree.
 * A proof does not itself create Attention: the host supplies the qualifying boundary to observe.
 */
export class OutcomeProvenance {
  private readonly outcomes = new Map<number, number>();
  // Recency is by last update, not ordinal: upserts can revisit an older row. Sets keep
  // candidates bounded by Entry count while allowing a superseded candidate to fall back.
  private readonly parentRows = new Set<number>();
  private readonly parentAnswers = new Set<number>();
  private readonly parentFailures = new Set<number>();
  private readonly parentTools = new Set<number>();
  private turnId: string | undefined;
  private turnStart: number | undefined;

  get(index: number): number | undefined { return this.outcomes.get(index); }

  private resetTurn(): void {
    this.parentRows.clear();
    this.parentAnswers.clear();
    this.parentFailures.clear();
    this.parentTools.clear();
    this.turnId = undefined;
    this.turnStart = undefined;
  }

  /** Returns proof-only changes too: turn_ended commonly leaves every Entry identity unchanged. */
  advance(logged: LoggedEvent, previous: Entry[], entries: Entry[]): number[] {
    const event = logged.event;
    const changed = new Set<number>();
    const stamp = (index: number) => {
      if (index < 0 || this.outcomes.get(index) === logged.seq) return;
      this.outcomes.set(index, logged.seq);
      changed.add(index);
    };
    const revoke = (index: number) => {
      if (this.outcomes.delete(index)) changed.add(index);
    };
    const row = (kind: Entry["kind"], id: string) => entries.findIndex(item => item.kind === kind && item.id === id);
    // A replacement card may carry the spawning tool's proof. Reusing either surface
    // invalidates that shared proof too, but must not erase a later independent failure.
    const supersede = (index: number) => {
      const boundary = this.outcomes.get(index);
      if (boundary === undefined) return;
      const item = entries[index]!;
      revoke(index);
      if (item.kind === "tool" || item.kind === "enquiry" || item.kind === "subagent") {
        for (const kind of ["tool", "enquiry", "subagent"] as const) {
          const related = row(kind, item.id);
          if (this.outcomes.get(related) === boundary) revoke(related);
        }
      }
    };
    const reusedInTurn = (index: number) => {
      const boundary = this.outcomes.get(index);
      return boundary !== undefined && this.turnStart !== undefined && boundary < this.turnStart;
    };
    const eligible = (index: number) => {
      const item = entries[index];
      return item !== undefined && !("producer" in item && item.producer) &&
        !(item.kind === "tool" && (item.status === "running" || item.authorisation === "asked")) &&
        !(item.kind === "enquiry" && item.status === "asked");
    };
    const failure = (index: number) => {
      const item = entries[index];
      return eligible(index) && ((item?.kind === "tool" && item.status === "error") ||
        (item?.kind === "notice" && item.level === "error"));
    };
    const touch = (set: Set<number>, index: number, valid: boolean) => {
      set.delete(index);
      if (valid) set.add(index);
    };
    const parent = (index: number) => {
      touch(this.parentRows, index, eligible(index));
      touch(this.parentAnswers, index, eligible(index) && entries[index]?.kind === "assistant");
      touch(this.parentFailures, index, failure(index));
    };
    const latest = (candidates: Set<number>, valid: (index: number) => boolean) => {
      let latest: number | undefined;
      for (const index of candidates) if (valid(index)) latest = index;
      return latest;
    };
    switch (event.type) {
      case "turn_started":
        this.resetTurn();
        this.turnId = event.turnId;
        this.turnStart = logged.seq;
        break;
      case "message": {
        const index = row("assistant", event.id);
        const old = previous[index];
        const item = entries[index];
        if (reusedInTurn(index) || (old?.kind === "assistant" && item?.kind === "assistant" &&
          (old.final && !item.final || old.producer?.subagentId !== item.producer?.subagentId))) supersede(index);
        parent(index);
        break;
      }
      case "tool_started":
      case "tool_updated":
      case "tool_ended":
      {
        const index = row("tool", event.callId);
        const old = previous[index];
        const item = entries[index];
        if (reusedInTurn(index) || (old?.kind === "tool" && item?.kind === "tool" &&
          (old.status !== item.status || old.producer?.subagentId !== item.producer?.subagentId))) supersede(index);
        if (event.type === "tool_started") {
          touch(this.parentTools, index, item?.kind === "tool" && !item.producer);
          parent(index);
        } else if (event.type === "tool_ended" && this.parentTools.has(index) && item?.kind === "tool" &&
          (old?.kind !== "tool" || old.status === "running" || old.status !== item.status)) {
          parent(index);
        } else if (!eligible(index)) {
          this.parentRows.delete(index);
          this.parentFailures.delete(index);
        }
        // Progress and duplicate terminal snapshots cannot introduce an old call from another
        // turn or displace the most recent real result in a tool-only parent turn.
        break;
      }
      case "enquiry": {
        const index = row("enquiry", event.askId);
        const old = previous[index];
        const item = entries[index];
        if (reusedInTurn(index) || (old?.kind === "enquiry" && item?.kind === "enquiry" &&
          (old.status !== item.status || old.producer?.subagentId !== item.producer?.subagentId))) supersede(index);
        parent(index);
        break;
      }
      case "permission": {
        const index = row("tool", event.callId);
        if (event.state === "asked") supersede(index);
        // Permission snapshots are not results, but can invalidate an earlier candidate.
        if (!eligible(index)) {
          this.parentRows.delete(index);
          this.parentFailures.delete(index);
        }
        break;
      }
      case "notice": {
        const workflow = event.text === "Workflow requires recovery. The parent will inspect it when free." ||
          event.text === "Workflow completed. The parent will prepare the result when free.";
        // Host-owned Workflow boundaries are independent, never parent fallback candidates.
        if (!workflow) parent(entries.length - 1);
        // Dispatch failures have arbitrary error text; Workflow notices have their own raw boundary.
        if (event.level === "error" || workflow) stamp(entries.length - 1);
        break;
      }
      case "compacted":
        parent(entries.length - 1);
        break;
      case "subagent":
      case "background_call": {
        const kind = event.type;
        const id = event.type === "subagent" ? event.subagentId : event.callId;
        const index = row(kind, id);
        const old = previous[index];
        const item = entries[index];
        if (old && item && (old.kind === "subagent" || old.kind === "background_call") &&
          (item.kind === "subagent" || item.kind === "background_call") &&
          ((old.status !== "running" && old.status !== "waiting" && old.status !== event.state) ||
            old.producer?.subagentId !== item.producer?.subagentId)) supersede(index);
        // Match host markAttention: only an error transition from previously open independent work.
        if (event.state === "error" && old && (old.kind === "subagent" || old.kind === "background_call") &&
          (old.status === "running" || old.status === "waiting")) stamp(index);
        break;
      }
      case "turn_ended": {
        // Late tool progress and independent Workflow notices must not stand in for an answer
        // outside the tail. An explicit parent failure takes precedence on failed turns.
        const index = (event.reason === "error" ? latest(this.parentFailures, failure) : undefined) ??
          latest(this.parentAnswers, eligible) ?? latest(this.parentRows, eligible);
        if (event.reason !== "aborted" && (this.turnId === undefined || this.turnId === event.turnId) && index !== undefined) {
          const item = entries[index]!;
          // An upsert can have changed attribution since this row became the parent candidate.
          if (!("producer" in item && item.producer)) {
            stamp(index);
            // These cards replace their spawning tool in the human-facing transcript.
            if (item.kind === "tool") {
              stamp(row("subagent", item.id));
              const enquiry = row("enquiry", item.id);
              if (eligible(enquiry)) stamp(enquiry);
            }
          }
        }
        this.resetTurn();
        break;
      }
      case "session_dormant":
        if (event.reason === "backend worker lost") stamp(entries.length - 1);
        this.resetTurn();
        break;
      case "session_settled":
      case "session_ended":
      case "revived":
      case "session_started":
        this.resetTurn();
        break;
    }
    return [...changed];
  }
}
