import type { Connection, LinkState, SubscribeOptions } from "../../../src/client/connection.ts";
import type { Entry, ViewState } from "../../../src/client/reduce.ts";
import { initialState, reduce } from "../../../src/client/reduce.ts";
import type { LoggedEvent } from "../../../src/protocol/events.ts";
import { entryKey } from "../presentation/entry-key.ts";
import type { AgentSessionView, Chrome } from "./contract.ts";
import { coalesce, scheduleFrame, type FrameScheduler } from "./frame-scheduler.ts";

/**
 * One Agent Session's Presentation Transcript, reduced and published in the three surfaces
 * `contract.ts` describes.
 *
 * Everything DOM-shaped is somebody else's: the transport is injected, the frame scheduler is
 * injected, and the result is that the whole state layer runs under `node --test` with frames driven
 * synchronously.
 */

/** All this needs of a Connection. Narrow, so a test's fake is three lines rather than four methods. */
export type TranscriptTransport = Pick<Connection, "subscribe">;

export type AgentSessionViewOptions = {
  /** Injected so a test can drive frames synchronously. Defaults to one per animation frame. */
  schedule?: FrameScheduler | undefined;
  /**
   * Transport failures. The link state in Chrome says an Agent Session's stream is in trouble but
   * not why, and the reason is worth a toast.
   */
  onError?: ((error: Error) => void) | undefined;
};

/**
 * The registry's half of a view. `contract.ts` deliberately does not expose these: a component that
 * can start or stop a transport is a component that replays the whole Presentation Transcript on its
 * next remount.
 */
export type OwnedAgentSessionView = AgentSessionView & {
  start(): void;
  stop(): void;
};

export function createAgentSessionView(
  sessionId: string,
  transport: TranscriptTransport,
  options: AgentSessionViewOptions = {},
): OwnedAgentSessionView {
  let view = initialState();
  let link: LinkState = "connecting";
  let chrome = chromeOf(view, link);

  let keys: readonly string[] = [];
  let keysStale = false;
  let index: Map<string, Entry> | undefined;

  let chromeDirty = false;
  let transcriptDirty = false;
  const chromeListeners = new Set<() => void>();
  const transcriptListeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;

  const notify = coalesce(() => {
    const chromeChanged = chromeDirty;
    const transcriptChanged = transcriptDirty;
    chromeDirty = false;
    transcriptDirty = false;
    // Copied before iterating: a listener that unsubscribes while being notified must not shorten
    // the set being walked.
    if (chromeChanged) for (const listener of [...chromeListeners]) listener();
    if (transcriptChanged) for (const listener of [...transcriptListeners]) listener();
  }, options.schedule ?? scheduleFrame);

  function apply(logged: LoggedEvent): void {
    const next = reduce(view, logged);
    // reduce is documented as handing back the same object when an event changed nothing
    // (reduce.ts:54) — a free bail-out before any work. It does not actually fire today, because
    // applyEvent spreads state on every branch, so the identity check on `entries` below is what
    // saves the work in practice. Kept anyway: it is reduce's stated contract, it costs one
    // comparison, and if the reducer ever honours it this is where the saving lands.
    if (next === view) return;

    const entriesChanged = next.entries !== view.entries;
    view = next;
    if (entriesChanged) {
      index = undefined;
      // Length alone decides whether the key list changed, and that is sound only because the
      // Presentation Transcript is append-only (ADR 0001): `upsert` replaces an entry in place or
      // appends (reduce.ts:169-172), `patchTool` replaces in place (reduce.ts:184-185), and notices
      // and markers append. A `subagent` snapshot upserts by id, so a Subagent's whole life —
      // running, waiting, and its terminal state — adds exactly one entry however many snapshots it
      // takes. Nothing is ever reordered or removed, so an unchanged length means an
      // unchanged key list — which is what lets getKeys() hand back the same array while an
      // assistant snapshot grows twenty times a second, and so what keeps TranscriptView out of the
      // streaming path entirely. If reduce ever learns to remove, filter or sort entries, this is
      // the line that breaks, and it breaks quietly, as a key list that no longer matches the
      // transcript. Anything that changes the shape of the transcript has to change this too.
      // Collapsing a Subagent does not: it filters the *key* list in TranscriptView and leaves
      // `entries` alone, which is exactly why ADR 0015 requires it to work that way.
      if (next.entries.length !== keys.length) keysStale = true;
      transcriptDirty = true;
      notify();
    }
    publishChrome();
  }

  function publishChrome(): void {
    const next = chromeOf(view, link);
    if (sameChrome(chrome, next)) return;
    chrome = next;
    chromeDirty = true;
    notify();
  }

  function setLink(next: LinkState): void {
    if (next === link) return;
    link = next;
    publishChrome();
  }

  function getKeys(): readonly string[] {
    // Rebuilt on read rather than on write: a replay appends a thousand times before anything reads,
    // and rebuilding per append would be quadratic in the length of the transcript. Reads happen
    // once per frame, after the notify, so this runs once per frame at most.
    if (keysStale) {
      keys = view.entries.map(entryKey);
      keysStale = false;
    }
    return keys;
  }

  function currentIndex(): Map<string, Entry> {
    if (!index) {
      index = new Map();
      for (const entry of view.entries) index.set(entryKey(entry), entry);
    }
    return index;
  }

  function subscribeTo(listeners: Set<() => void>, listener: () => void): () => void {
    // A Set, so subscribing the same listener twice leaves one subscription: useSyncExternalStore
    // subscribes, unsubscribes and subscribes again under StrictMode, and neither the second
    // subscribe nor the first unsubscribe may disturb anything. Note what is *not* here — nothing
    // starts the transport. acquire() does that (9.1(a)).
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    sessionId,

    subscribeChrome: (listener) => subscribeTo(chromeListeners, listener),
    getChrome: () => chrome,

    subscribeTranscript: (listener) => subscribeTo(transcriptListeners, listener),
    getKeys,

    getEntry: (key) => currentIndex().get(key),

    start(): void {
      if (unsubscribe) return;
      const subscription: SubscribeOptions = {
        sessionId,
        // Resume, never replay. connection.ts keeps its own lastSeq from here and reconnects
        // against it, and asking for 0 again would re-append every notice and every marker, whose
        // Entry ids are derived from the transcript's length at the time.
        since: view.lastSeq,
        onEntry: apply,
        onLink: setLink,
        // Spread conditionally rather than assigned undefined, because the root program has
        // exactOptionalPropertyTypes on and this module is checked by it.
        ...(options.onError ? { onError: options.onError } : {}),
      };
      unsubscribe = transport.subscribe(subscription);
    },

    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

function chromeOf(view: ViewState, link: LinkState): Chrome {
  return {
    status: view.status,
    backend: view.backend,
    scope: view.scope,
    capabilities: view.capabilities,
    model: view.model,
    effort: view.effort,
    branch: view.branch,
    worktree: view.worktree,
    contextUsage: view.contextUsage,
    compacting: view.compacting === true,
    spoken: view.spoken === true,
    endedReason: view.endedReason,
    // No lastSeq: it is stamped from the event's own seq on every event, so carrying it here would
    // make Chrome differ on every streaming tick and the shallow compare below could never suppress
    // a publish. See the note in contract.ts. Resume bookkeeping stays with `since` above.
    queueDepth: view.queue.length,
    activeSubagents: view.activeSubagents,
    asking: view.asking,
    authorising: view.authorising,
    link,
  };
}

/**
 * Shallow, and generic over Chrome's keys rather than field by field, so a field added to the
 * contract is compared without anyone remembering to come back here.
 *
 * `contextUsage`, `model` and `capabilities` are therefore compared by identity, and reduce builds a
 * fresh object for each of them when its event arrives. Those events arrive per turn, not per frame,
 * so a deeper compare would buy a render an hour.
 */
export function sameChrome(left: Chrome, right: Chrome): boolean {
  for (const key of Object.keys(left) as Array<keyof Chrome>) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}
