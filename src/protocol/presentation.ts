import type { Entry, ViewState } from "../client/reduce.ts";

/** Zero-based ordinal in the complete reduced Presentation Transcript, not an event sequence. */
export type IndexedEntry = { index: number; entry: Entry };

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
