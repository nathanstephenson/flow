import type { Connection, LinkState, SubscribeOptions } from "../../../src/client/connection.ts";
import type { Entry, ViewState } from "../../../src/client/reduce.ts";
import { initialState, reduce } from "../../../src/client/reduce.ts";
import type { LoggedEvent } from "../../../src/protocol/events.ts";
import { OutcomeProvenance, type IndexedEntry, type PresentationSnapshot, type PresentationUpdate } from "../../../src/protocol/presentation.ts";
import { entryKey } from "../presentation/entry-key.ts";
import type { AgentSessionView, Chrome, TranscriptHistory } from "./contract.ts";
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
export type TranscriptTransport = Pick<Connection, "subscribe"> & Partial<Pick<Connection, "subscribePresentation" | "readPresentation">>;

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
  let outcomeIndex = new Map<string, number>();
  const rawOutcomes = new OutcomeProvenance();

  let chromeDirty = false;
  let transcriptDirty = false;
  const chromeListeners = new Set<() => void>();
  const beforeTranscriptListeners = new Set<(earlier?: number) => void>();
  const transcriptListeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  let windowStart: number | undefined;
  const positioned = new Map<number, { entry: Entry; seq: number; outcomeSeq?: number }>();
  let activityKeys: readonly string[] = [];
  let positionedKeysStale = true;
  let history: TranscriptHistory = { earlier: 0, loading: !!transport.subscribePresentation, loadingOlder: false, error: undefined };
  let olderRequest: AbortController | undefined;
  let olderPromise: Promise<void> | undefined;

  const notify = coalesce(() => {
    const chromeChanged = chromeDirty;
    const transcriptChanged = transcriptDirty;
    chromeDirty = false;
    transcriptDirty = false;
    // Copied before iterating: a listener that unsubscribes while being notified must not shorten
    // the set being walked.
    // DOM measurements must happen before either reactive surface can synchronously commit.
    if (transcriptChanged) for (const listener of [...beforeTranscriptListeners]) listener();
    if (chromeChanged) for (const listener of [...chromeListeners]) listener();
    if (transcriptChanged) for (const listener of [...transcriptListeners]) listener();
  }, options.schedule ?? scheduleFrame);

  function publishHistory(next: TranscriptHistory): void {
    if (history.earlier === next.earlier && history.loading === next.loading &&
      history.loadingOlder === next.loadingOlder && history.error === next.error) return;
    history = next;
    transcriptDirty = true;
    notify();
  }

  function mergePositioned(incoming: IndexedEntry[], seq: number): void {
    for (const item of incoming) {
      const previous = positioned.get(item.index);
      // A backward page may have left the host before a newer live patch arrived.
      if (previous && previous.seq > seq) continue;
      if (!previous || entryKey(previous.entry) !== entryKey(item.entry)) positionedKeysStale = true;
      positioned.set(item.index, { entry: item.entry, seq, ...(item.outcomeSeq === undefined ? {} : { outcomeSeq: item.outcomeSeq }) });
    }
  }

  function refreshPositionedKeys(): void {
    if (!positionedKeysStale) return;
    positionedKeysStale = false;
    const ordered = [...positioned].sort(([a], [b]) => a - b);
    const nextKeys = ordered.filter(([ordinal]) => ordinal >= (windowStart ?? Infinity)).map(([, item]) => entryKey(item.entry));
    const nextActivityKeys = ordered.map(([, item]) => entryKey(item.entry));
    if (!sameKeys(keys, nextKeys)) keys = nextKeys;
    if (!sameKeys(activityKeys, nextActivityKeys)) activityKeys = nextActivityKeys;
  }

  function publishPositioned(): void {
    index = undefined;
    transcriptDirty = true;
    notify();
  }

  function snapshot(incoming: PresentationSnapshot): void {
    if (incoming.start < (windowStart ?? 0)) {
      for (const listener of [...beforeTranscriptListeners]) listener(incoming.start);
    }
    positioned.clear();
    positionedKeysStale = true;
    windowStart = incoming.start;
    mergePositioned(incoming.related, incoming.seq);
    mergePositioned(incoming.entries, incoming.seq);
    view = { ...incoming.state, entries: [], lastSeq: incoming.seq };
    publishPositioned();
    publishHistory({ ...history, earlier: incoming.start, loading: false, error: undefined });
    publishChrome();
  }

  function update(incoming: PresentationUpdate): void {
    if (incoming.seq <= view.lastSeq) return;
    mergePositioned(incoming.entries, incoming.seq);
    view = { ...(incoming.state ?? view), entries: [], lastSeq: incoming.seq };
    publishPositioned();
    publishChrome();
  }

  function cancelOlder(): void {
    olderRequest?.abort();
    olderRequest = undefined;
    olderPromise = undefined;
    publishHistory({ ...history, loadingOlder: false });
  }

  function loadOlder(): Promise<void> {
    if (olderPromise) return olderPromise;
    const before = windowStart;
    if (before === undefined || before === 0 || link !== "live" || !transport.readPresentation) return Promise.resolve();
    const controller = new AbortController();
    olderRequest = controller;
    publishHistory({ ...history, loadingOlder: true, error: undefined });
    olderPromise = transport.readPresentation(sessionId, before, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      const earlier = Math.min(windowStart ?? before, page.start);
      // React can read external snapshots during unrelated renders before the coalesced notify.
      // Capture the old DOM before exposing the prefix, then allow notification-time recapture
      // if it has not committed yet and the reader moved in the intervening frame.
      if (earlier < (windowStart ?? before)) {
        for (const listener of [...beforeTranscriptListeners]) listener(earlier);
      }
      mergePositioned(page.entries, page.seq);
      windowStart = earlier;
      positionedKeysStale = true;
      publishPositioned();
      publishHistory({ ...history, earlier: windowStart });
    }).catch(error => {
      if (!controller.signal.aborted) publishHistory({ ...history, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (olderRequest !== controller) return;
      olderRequest = undefined;
      olderPromise = undefined;
      publishHistory({ ...history, loadingOlder: false });
    });
    return olderPromise;
  }

  function apply(logged: LoggedEvent): void {
    const next = reduce(view, logged);
    // reduce is documented as handing back the same object when an event changed nothing
    // (reduce.ts:54) — a free bail-out before any work. It does not actually fire today, because
    // applyEvent spreads state on every branch, so the identity check on `entries` below is what
    // saves the work in practice. Kept anyway: it is reduce's stated contract, it costs one
    // comparison, and if the reducer ever honours it this is where the saving lands.
    if (next === view) return;

    const entriesChanged = next.entries !== view.entries;
    const proofChanged = rawOutcomes.advance(logged, view.entries, next.entries).length > 0;
    view = next;
    if (entriesChanged || proofChanged) {
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
    if (next === "connecting" && transport.subscribePresentation) cancelOlder();
    if (next === "gone" && transport.subscribePresentation) publishHistory({ ...history, loading: false });
    if (next === link) return;
    link = next;
    publishChrome();
  }

  function getKeys(): readonly string[] {
    if (transport.subscribePresentation) { refreshPositionedKeys(); return keys; }
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
      outcomeIndex = new Map();
      if (transport.subscribePresentation) {
        for (const item of positioned.values()) {
          const key = entryKey(item.entry);
          index.set(key, item.entry);
          if (item.outcomeSeq !== undefined) outcomeIndex.set(key, item.outcomeSeq);
        }
      } else {
        view.entries.forEach((entry, ordinal) => {
          const key = entryKey(entry);
          index!.set(key, entry);
          const outcomeSeq = rawOutcomes.get(ordinal);
          if (outcomeSeq !== undefined) outcomeIndex.set(key, outcomeSeq);
        });
      }
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

    subscribeBeforeTranscript: (listener) => subscribeTo(beforeTranscriptListeners, listener),
    subscribeTranscript: (listener) => subscribeTo(transcriptListeners, listener),
    getKeys,
    getActivityKeys: () => {
      if (!transport.subscribePresentation) return getKeys();
      refreshPositionedKeys();
      return activityKeys;
    },
    getHistory: () => history,
    loadOlder,

    getEntry: (key) => currentIndex().get(key),
    getLastSeq: () => view.lastSeq,
    canObserveThrough(requiredOutcomeSeq, renderedKeys): boolean {
      // Delivery and paint are distinct. Only the exact host-supplied outcome boundary on a
      // rendered row proves observation; metadata, producer chatter and older outcomes do not.
      if (!Number.isSafeInteger(requiredOutcomeSeq) || requiredOutcomeSeq < 1 ||
        requiredOutcomeSeq > view.lastSeq || history.loading) return false;
      currentIndex();
      return renderedKeys.some(key => outcomeIndex.get(key) === requiredOutcomeSeq);
    },

    start(): void {
      if (unsubscribe) return;
      if (transport.subscribePresentation) {
        unsubscribe = transport.subscribePresentation({
          sessionId,
          start: () => windowStart,
          onSnapshot: snapshot,
          onUpdate: update,
          onLink: setLink,
          onError: error => {
            publishHistory({ ...history, error: error.message });
            options.onError?.(error);
          },
        });
        return;
      }
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
      cancelOlder();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

function sameKeys(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((key, index) => key === next[index]);
}

function chromeOf(view: ViewState, link: LinkState): Chrome {
  return {
    status: view.status,
    backend: view.backend,
    scope: view.scope,
    capabilities: view.capabilities,
    model: view.model,
    effort: view.effort,
    permissionMode: view.permissionMode,
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
    queuedMessages: view.queuedMessages,
    activeSubagents: view.activeSubagents,
    activeBackgroundCalls: view.activeBackgroundCalls,
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
