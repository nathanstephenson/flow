import { ArrowDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { createHaystackCache } from "@client/search.ts";
import { toolChains } from "@client/tool-chains.ts";
import { isPinned } from "@/presentation/stick-to-bottom.ts";
import type { AgentSessionView } from "@/store/contract.ts";
import { useChrome, useEntry, useTranscriptHistory, useTranscriptKeys } from "@/agent-session-view.tsx";
import { TranscriptEntry } from "@/components/transcript-entry.tsx";
import { ToolChain } from "@/components/tool-chain.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ownKeys } from "@/presentation/subagent-rows.ts";

/**
 * The Presentation Transcript, as a document.
 *
 * **Not virtualised, deliberately.** Virtualising would destroy per-entry state (a tool disclosure a
 * reader opened, a thinking block they expanded, a selection they made), and it would break
 * find-in-page over a record ADR 0001 defines as *what a human saw* — a Cmd-F that searches the
 * thirty entries currently mounted is a lie about that record. It also buys nothing in steady state:
 * the key index, `memo` and the store's per-frame coalescing already reduce a streaming tick to one
 * row re-rendering. Growing, variable-height content is the worst case for every virtualiser anyway.
 *
 * The Session Host supplies a bounded tail first, with older pages available at the visible boundary
 * below. Nothing is dropped once loaded; search explicitly fills in the missing earlier pages.
 */

export function TranscriptView({
  view,
  query,
  visible = true,
  observedBoundary,
  onObserved,
}: {
  view: AgentSessionView;
  query: string;
  /** False when mobile is showing a Dock over the still-mounted transcript. */
  visible?: boolean;
  /** Qualifying attention boundary, not the transport cursor. */
  observedBoundary?: number | undefined;
  /** Called only once the transcript is painted, focused, visible, and pinned to its newest row. */
  onObserved?: (throughSeq: number) => void;
}) {
  const keys = useTranscriptKeys(view);
  const history = useTranscriptHistory(view);
  const { link } = useChrome(view);
  const matching = useFilteredKeys(view, keys, query);

  // A Subagent's own rows belong to the Agents tab, not here (ADR 0015). This filters *keys*, never
  // `entries` — filtering the entry list would break the length heuristic the store relies on. What
  // survives is the session's own work plus the card saying a Subagent was started.
  const getEntry = useCallback((key: string) => view.getEntry(key), [view]);
  const shown = useMemo(() => ownKeys(matching, getEntry), [matching, getEntry]);

  const restore = useRef<{ height: number; top: number; anchor: Element | undefined; offset: number } | undefined>(undefined);
  const restored = useRef<{ top: number; anchor: Element; offset: number; viewportTop: number } | undefined>(undefined);

  // After the loaded tail and the filter: a Tool Chain says "these rows are adjacent",
  // and the only list it can say that about honestly is the one the reader is looking at.
  const segments = useMemo(() => toolChains(shown), [shown]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  const followBottom = useCallback(() => {
    const element = scroller.current;
    if (!element || !pinned.current) return;
    element.scrollTop = element.scrollHeight;
    lastScrollTop.current = element.scrollTop;
  }, []);
  const [atBottom, setAtBottom] = useState(true);
  const reportObserved = useCallback((throughSeq: number) => {
    if (!visible || !pinned.current || document.hidden || !document.hasFocus()) return;
    if (observedBoundary !== undefined &&
      (throughSeq < observedBoundary || !view.canObserveThrough(observedBoundary, shown))) return;
    onObserved?.(throughSeq);
  }, [onObserved, visible, observedBoundary, view, shown]);
  const reportObservedRef = useRef(reportObserved);
  reportObservedRef.current = reportObserved;
  const paintFrames = useRef<[number, number]>([0, 0]);
  const scheduleObserved = useCallback((throughSeq = view.getLastSeq()) => {
    cancelAnimationFrame(paintFrames.current[0]);
    cancelAnimationFrame(paintFrames.current[1]);
    paintFrames.current[0] = requestAnimationFrame(() => {
      paintFrames.current[1] = requestAnimationFrame(() => reportObservedRef.current(throughSeq));
    });
  }, [view]);

  useEffect(() => scheduleObserved());
  useEffect(
    () => () => {
      cancelAnimationFrame(paintFrames.current[0]);
      cancelAnimationFrame(paintFrames.current[1]);
    },
    [],
  );

  useEffect(() => {
    const observeCurrent = () => scheduleObserved();
    window.addEventListener("focus", observeCurrent);
    document.addEventListener("visibilitychange", observeCurrent);
    return () => {
      window.removeEventListener("focus", observeCurrent);
      document.removeEventListener("visibilitychange", observeCurrent);
    };
  }, [scheduleObserved]);

  /**
   * The pin is derived from the reader's own scrolling rather than measured before a commit and
   * restored after it: React has no `getSnapshotBeforeUpdate`, and a measurement taken before a
   * commit can be invalidated by the very content change that prompted it.
   *
   * Passive, because this handler never calls `preventDefault` and the browser should not have to
   * wait to find out. The React state is throttled separately: reader scrolling can fire on every
   * animation frame, so publishing state from every event would thrash.
   */
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let throttle: ReturnType<typeof setTimeout> | undefined;

    const onScroll = (): void => {
      // A scroll we requested can arrive after an image/font has grown the document again. Its
      // distance from the bottom is no longer zero, but the reader has not moved. Only a changed
      // position may release the pin; the content observer will catch up with the new height.
      if (element.scrollTop === lastScrollTop.current) return;
      lastScrollTop.current = element.scrollTop;
      pinned.current = isPinned(element);
      if (throttle) return;
      throttle = setTimeout(() => {
        throttle = undefined;
        setAtBottom(pinned.current);
        if (pinned.current) scheduleObserved();
      }, 150);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (throttle) clearTimeout(throttle);
    };
  }, [scheduleObserved]);

  /**
   * Hold the pin while either the viewport or the document changes height.
   *
   * The Composer floats over this scroller and pads it clear of itself with `--composer-inset`, so
   * anything that changes the Composer's height changes this element's padding: the `/` menu opening,
   * an image attached, the input growing a line, a Subagent strip appearing. None of those re-render
   * the transcript, and the only other re-pin runs in a layout effect that fires on a *render* — so
   * the padding grew underneath the content and nothing put the reader back at the bottom until the
   * next unrelated tick. Against an animated menu that reads as the chat lagging behind it.
   *
   * Observe the scroller for those inset/viewport changes, and the document for late image loads,
   * font swaps, and row disclosures. Those can grow a freshly opened transcript *after* its last
   * React commit, including an Idle Agent Session that will never get another streaming tick.
   * Setting `scrollTop` changes neither box's size, so this cannot feed itself.
   */
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const observer = new ResizeObserver(() => {
      followBottom();
      scheduleObserved();
    });
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [followBottom, scheduleObserved]);

  /**
   * A search changes the visible set wholesale, so the distance from the bottom jumps without the
   * reader touching anything. Going to the bottom is the only interpretation that is never wrong.
   */
  useLayoutEffect(() => {
    restore.current = undefined;
    restored.current = undefined;
    pinned.current = true;
    followBottom();
    setAtBottom(true);
  }, [query, view, followBottom]);

  const renderedHistory = useRef({ view, earlier: history.earlier });
  useLayoutEffect(() => { renderedHistory.current = { view, earlier: history.earlier }; }, [view, keys, history.earlier]);
  useEffect(() => view.subscribeBeforeTranscript((earlier = view.getHistory().earlier) => {
    // Any surface can extend the shared suffix. Capture before exposing it to React, then
    // recapture at notification time if still uncommitted and the reader has kept moving.
    const element = scroller.current;
    if (pinned.current || !element || renderedHistory.current.view !== view ||
      earlier >= renderedHistory.current.earlier) return;
    const top = element.getBoundingClientRect().top;
    const previous = restored.current;
    const samePosition = previous?.top === element.scrollTop && previous.viewportTop === top &&
      previous.anchor.isConnected && previous.anchor.getBoundingClientRect().bottom > top;
    const anchor = samePosition ? previous.anchor : [...(content.current?.children ?? [])].find(child => child.tagName === "DIV" && child.getBoundingClientRect().bottom > top);
    // Keep the intended offset until the reader moves, rather than accumulating fractional-scroll
    // rounding on each page of an automatic search backfill.
    const offset = samePosition ? previous.offset : anchor?.getBoundingClientRect().top ?? 0;
    restore.current = { height: element.scrollHeight, top: element.scrollTop, anchor, offset };
  }), [view]);
  const loadOlder = useCallback(() => {
    pinned.current = false;
    setAtBottom(false);
    void view.loadOlder();
  }, [view]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const saved = restore.current;
    if (!element || !saved) return;
    // Prefer a retained visible row: live output may also have grown *below* it while the backward
    // page arrived. A total-height delta alone would count that growth and move the reader.
    const delta = saved.anchor?.isConnected ? saved.anchor.getBoundingClientRect().top - saved.offset : element.scrollHeight - saved.height;
    element.scrollTop = saved.top + delta;
    lastScrollTop.current = element.scrollTop;
    restored.current = saved.anchor?.isConnected ? { top: element.scrollTop, anchor: saved.anchor, offset: saved.offset, viewportTop: element.getBoundingClientRect().top } : undefined;
    restore.current = undefined;
  }, [keys]);

  useEffect(() => {
    // One page per successful transition: a failed read remains stopped, but an explicit retry
    // that clears the error and advances the boundary resumes the same whole-record search.
    if (!query || history.loading || history.loadingOlder || history.error ||
      history.earlier === 0 || link !== "live") return;
    void view.loadOlder();
  }, [query, view, history.loading, history.loadingOlder, history.error, history.earlier, link]);

  const toBottom = useCallback(() => {
    restored.current = undefined;
    pinned.current = true;
    followBottom();
    setAtBottom(true);
    scheduleObserved();
  }, [followBottom, scheduleObserved]);

  return (
    <div className="relative min-h-0 min-w-0">
      {/*
       * The scroller stays full width so its scrollbar sits at the pane's edge; `pane-measure` is the
       * column inside it, shared with the Composer floating below so the two line up.
       */}
      <div
        ref={scroller}
        // The Composer floats over this, so the last line of the last message would sit behind it. The
        // inset is the Composer's measured height; `stick-to-bottom.ts` needs no change, because padding
        // is part of scrollHeight and the distance from the bottom is still zero at the bottom.
        className="transcript-scroller h-full px-3 pt-2 pb-[calc(var(--composer-inset,0px)+1.5rem)]"
      >
        <div ref={content} className="pane-measure">
          {history.earlier > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={loadOlder}
              disabled={history.loadingOlder || link !== "live"}
              className="mb-2 h-auto w-full whitespace-normal py-1 text-muted-foreground"
            >
              {history.loadingOlder ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              {history.loadingOlder ? "Loading earlier transcript entries…" : `${history.earlier.toLocaleString()} earlier transcript entries · load earlier`}
            </Button>
          ) : null}
          {history.error ? <p role="alert" className="px-1 py-2 text-xs text-destructive">Could not load transcript entries: {history.error}</p> : null}
          {query && history.earlier > 0 ? <p role="status" className="px-1 py-2 text-xs text-muted-foreground">{history.error ? "Search covers loaded entries only; earlier entries could not be loaded." : "Searching earlier transcript entries…"}</p> : null}
          {segments.map((segment) =>
            segment.kind === "entry" ? (
              <TranscriptRow key={segment.key} view={view} entryKey={segment.key} query={query} />
            ) : (
              <ToolChain key={segment.keys[0]} view={view} keys={segment.keys}>
                {segment.keys.map((key) => (
                  <TranscriptRow key={key} view={view} entryKey={key} query={query} />
                ))}
              </ToolChain>
            ),
          )}

          {shown.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">
              {history.loading ? "Loading latest transcript entries…" : history.error && keys.length === 0 ? "Transcript unavailable." : history.earlier > 0 ? "No matching entries in the loaded tail." : keys.length === 0 ? "Nothing here yet." : "No Entry matches."}
            </p>
          ) : null}

          <StickToBottom view={view} followBottom={followBottom} scheduleObserved={scheduleObserved} />
        </div>
      </div>

      {atBottom ? null : <NewEntriesPill onClick={toBottom} />}
    </div>
  );
}

/**
 * One row, subscribed to its own Entry.
 *
 * The indirection exists so that `TranscriptEntry` never takes the view: this component takes it and
 * the key, reads the Entry, and hands down only what one row needs. `sessionId` is part of that
 * because an Attachment is addressed under its Agent Session — the id in an Entry names a file, not
 * a URL, and only the session it belongs to completes one.
 */
function TranscriptRow({ view, entryKey, query }: { view: AgentSessionView; entryKey: string; query: string }) {
  const entry = useEntry(view, entryKey);
  // A key with no Entry cannot happen while the transcript is append-only, but rendering nothing is
  // the right answer if it ever does.
  if (!entry) return null;
  return <TranscriptEntry entry={entry} query={query} sessionId={view.sessionId} />;
}

/**
 * Re-applies the pin on every frame the transcript changed, and nothing else.
 *
 * It exists as its own component so that *it* is the thing re-rendering twenty times a second rather
 * than TranscriptView and its whole child list. Its layout effect lands in the same commit as the
 * row that changed — both were triggered by the same coalesced notify — so it reads the DOM after
 * the mutation, which is exactly what a pre-mutation measurement could not do.
 *
 * The effect has no dependency array on purpose: it must run on *every* commit, not only when an
 * entry was added, because a growing snapshot under `pre-wrap` rewraps lines above itself and
 * changes the scroll height without appending anything.
 */
function StickToBottom({
  view,
  followBottom,
  scheduleObserved,
}: {
  view: AgentSessionView;
  followBottom: () => void;
  scheduleObserved: (throughSeq?: number) => void;
}) {
  const [, setTick] = useState(0);

  useEffect(() => view.subscribeTranscript(() => setTick((tick) => tick + 1)), [view]);

  useLayoutEffect(() => {
    followBottom();
    scheduleObserved(view.getLastSeq());
  });

  return null;
}

/**
 * Offered only when the reader has scrolled away, because that is the only time it means anything.
 * The arrow alone carries it: `Entry` carries no seq, so "N new since you looked" is not a number
 * this front end can honestly produce, which leaves nothing for a label to say that the icon does not.
 */
function NewEntriesPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Jump to latest"
      className="-translate-x-1/2 absolute bottom-[calc(var(--composer-inset,0px)+1.5rem)] left-1/2 rounded-full border bg-popover p-2 text-popover-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowDown className="size-4" />
    </button>
  );
}

/**
 * The visible key list.
 *
 * Filtering lives here rather than in the store: the store's job is the reduced, append-only state,
 * and a per-viewer presentation filter is not that — a query is typed and cleared without anything
 * having happened to the Presentation Transcript, and the TUI filters the same record its own way.
 *
 * With no query this is the store's own array, so TranscriptView re-renders only when an entry is
 * added. With a query it recomputes on every coalesced tick, which is the cost of a filter that
 * stays correct mid-stream: a growing snapshot that *newly* matches starts matching on the tick it
 * does, which a `useMemo` keyed on the key list would miss because the key list did not change.
 */
function useFilteredKeys(view: AgentSessionView, keys: readonly string[], query: string): readonly string[] {
  const cache = useMemo(() => createHaystackCache(), []);
  const [filtered, setFiltered] = useState<readonly string[]>(keys);

  useEffect(() => {
    if (query === "") return;

    const recompute = (): void => {
      const next = view.getKeys().filter((key) => {
        const entry = view.getEntry(key);
        return entry !== undefined && cache.matches(entry, query);
      });
      // Same list, same array: an unchanged filter must not re-render the transcript.
      setFiltered((previous) =>
        previous.length === next.length && previous.every((key, index) => key === next[index]) ? previous : next,
      );
    };

    recompute();
    return view.subscribeTranscript(recompute);
  }, [view, query, cache]);

  // A backward page changes keys before the notification's filtered state is committed. Derive
  // that new set in this render so scroll restoration measures the actual prepended DOM, not the
  // previous filter. Ordinary text ticks still bail out in recompute when their match set is equal.
  return useMemo(() => {
    if (query === "") return keys;
    const next = keys.filter(key => {
      const entry = view.getEntry(key);
      return entry !== undefined && cache.matches(entry, query);
    });
    return filtered.length === next.length && filtered.every((key, index) => key === next[index]) ? filtered : next;
  }, [view, keys, query, cache, filtered]);
}
