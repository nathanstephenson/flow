// The contract between the app's state layer and its components. It exists as its own file so the
// two can be built against one another without either guessing.
//
// The shape is driven by one fact about the reducer: a streamed `message` or `thinking` event carries
// the whole accumulated text each time, so on every frame `reduce` returns a fresh ViewState and a
// fresh `entries` array, while the Entry objects that did not change keep their identity. A single
// getSnapshot() returning ViewState would therefore re-render every subscriber twenty times a second.
// Splitting it into three surfaces — chrome, the key list, and one entry at a time — means a
// streaming snapshot re-renders exactly one row.
import type { Entry, ViewState } from "../../../src/client/reduce.ts";
import type { LinkState } from "../../../src/client/connection.ts";
import type { Capabilities, EffortLevel, ModelInfo } from "../../../src/protocol/events.ts";
import type { SessionStatus } from "../../../src/protocol/commands.ts";
import type { Branch } from "../../../src/protocol/git.ts";

/**
 * Everything the pane header and composer need, and nothing that changes as text streams in.
 *
 * Shallow-compared before it is published, so a four-thousand-token assistant snapshot arriving
 * twenty times a second produces zero header renders.
 */
export type Chrome = {
  status: SessionStatus;
  backend: string | undefined;
  scope: string | undefined;
  capabilities: Capabilities | undefined;
  model: ModelInfo | undefined;
  effort: EffortLevel | undefined;
  /** Absent when the Scope is not a repository, which is how the header hides the control. */
  branch: Branch | undefined;
  /** Set when the Scope is a worktree the host made, so the header can still name the Project. */
  worktree: true | undefined;
  contextUsage: ViewState["contextUsage"];
  endedReason: string | undefined;
  /**
   * No `lastSeq` here, deliberately. `reduce` stamps it from the event's own seq on every single
   * event, so including it would make Chrome differ on every streamed frame and the shallow compare
   * could never suppress a publish — which is the entire reason this snapshot is separate from the
   * transcript. Resume bookkeeping belongs to the store and to connection.ts, and no part of the
   * chrome displays a sequence number.
   */

  /** Depth only. The Steering Queue itself belongs to the Session Host (ADR 0002). */
  queueDepth: number;
  /**
   * Subagents running or waiting right now.
   *
   * A count, not the Subagents themselves. Chrome is compared by shallow identity, so a derived
   * array would be a fresh object every tick and could never be suppressed — the same trap the
   * `lastSeq` note above describes. Anything wanting the Subagents reads the transcript surface.
   */
  activeSubagents: number;
  /**
   * Background Calls running right now (ADR 0021).
   *
   * A count for the reason above, and a second one rather than added into `activeSubagents` because
   * only that one has a pane behind it: a backgrounded `Bash` counted there would offer a reader a
   * card that does not exist.
   */
  activeBackgroundCalls: number;
  /**
   * The Enquiry blocking this turn, whole, or undefined.
   *
   * An object on a shallow-compared snapshot, which the note above appears to forbid — but what that
   * note refuses is a *derived* value, an array rebuilt on every tick that can never compare equal to
   * the one before it. This is the opposite: `reduce` mints it once, when the Enquiry is first asked,
   * and carries the same reference through every streamed frame until something terminal drops it.
   * Its identity changes exactly twice per Enquiry, which is the contract `model` and `capabilities`
   * already hold here.
   *
   * Whole rather than an id, because the Composer is handed `chrome` and nothing else — it has no
   * `getEntry`, and giving it one so it could fetch a body it could have been handed is a second data
   * channel for a single object.
   */
  asking: ViewState["asking"];
  /**
   * The Permission Prompt blocking this turn, whole, or undefined.
   *
   * Held to the same contract as `asking` and safe for the same reason: `reduce` mints it once and
   * carries the reference until something terminal drops it. It is deliberately *not* a list even
   * though several prompts can be open at once — an array rebuilt on each arrival is precisely what
   * the `activeSubagents` note above refuses. The reducer promotes the next one instead.
   *
   * All it carries is the id and the tool name. What the call would actually do reads off the
   * transcript surface, from the `tool` Entry sharing that id — the one place a component may go
   * looking, because the row is already on screen above the composer.
   */
  authorising: ViewState["authorising"];
  /** Set while the backend is summarising the Conversation Context. A boolean, so it compares. */
  compacting: boolean;
  /**
   * Whether anybody has said anything yet — what the overflow menu hides Rename on, since a Summary
   * Model has nothing to name in an empty Agent Session. A boolean, so it compares.
   */
  spoken: boolean;
  /** Transport state, so the UI can say the Session Host has gone rather than appear idle. */
  link: LinkState;
};

/**
 * A live view of one Agent Session's Presentation Transcript.
 *
 * Owned by the registry, not by a component: a store created in a component is disposed by
 * StrictMode's double mount and by every switch to another Agent Session, and each disposal replays
 * the whole transcript. `subscribe` must be idempotent and must never start the transport — `acquire` does.
 */
export type AgentSessionView = {
  readonly sessionId: string;

  subscribeChrome(listener: () => void): () => void;
  getChrome(): Chrome;

  /**
   * Identity-stable while entries only grow, so a transcript that is merely streaming does not
   * re-render. A new array is published only when an entry is added.
   */
  subscribeTranscript(listener: () => void): () => void;
  getKeys(): readonly string[];

  /** Keyed by `entryKey(entry)` — kind and id, because an id is only unique within a kind. */
  getEntry(key: string): Entry | undefined;
};

/**
 * Hands out views and keeps them alive across remounts.
 *
 * Release is grace-perioded rather than immediate for the same reason ownership sits here: React
 * unmounts and remounts freely, and a transport torn down on unmount means a full replay on the way
 * back in.
 */
export type AgentSessionViewRegistry = {
  acquire(sessionId: string): AgentSessionView;
  release(sessionId: string): void;
};
