import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { createHaystackCache } from "@client/search.ts";
import { isPinned } from "@/presentation/stick-to-bottom.ts";
import type { AgentSessionView } from "@/store/contract.ts";
import { useEntry, useTranscriptKeys } from "@/agent-session-view.tsx";
import { TranscriptEntry } from "@/components/transcript-entry.tsx";

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
 * The mitigation for a very long transcript is a tail window with a visible boundary, below. Nothing
 * is dropped once shown, and the boundary is honest that there is more.
 */
const TAIL_WINDOW = 400;

export function TranscriptView({ view, query }: { view: AgentSessionView; query: string }) {
  const keys = useTranscriptKeys(view);
  const visibleKeys = useFilteredKeys(view, keys, query);

  const [showAll, setShowAll] = useState(false);
  const windowed = showAll || visibleKeys.length <= TAIL_WINDOW ? visibleKeys : visibleKeys.slice(-TAIL_WINDOW);
  const earlier = visibleKeys.length - windowed.length;

  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  /**
   * The pin is derived from the reader's own scrolling rather than measured before a commit and
   * restored after it: React has no `getSnapshotBeforeUpdate`, and a measurement taken before a
   * commit can be invalidated by the very content change that prompted it.
   *
   * Passive, because this handler never calls `preventDefault` and the browser should not have to
   * wait to find out. The React state is throttled separately — a programmatic scroll re-fires this
   * listener, so writing state from it directly would thrash.
   */
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let throttle: ReturnType<typeof setTimeout> | undefined;

    const onScroll = (): void => {
      pinned.current = isPinned(element);
      if (throttle) return;
      throttle = setTimeout(() => {
        throttle = undefined;
        setAtBottom(pinned.current);
      }, 150);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (throttle) clearTimeout(throttle);
    };
  }, []);

  /**
   * A search changes the visible set wholesale, so the distance from the bottom jumps without the
   * reader touching anything. Going to the bottom is the only interpretation that is never wrong.
   */
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setAtBottom(true);
  }, [query, view]);

  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setAtBottom(true);
  }, []);

  return (
    <div className="relative min-h-0">
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
        <div className="pane-measure">
          {earlier > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mb-2 flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <span className="h-px flex-1 bg-border" aria-hidden />
              {earlier.toLocaleString()} earlier entries · show all
              <span className="h-px flex-1 bg-border" aria-hidden />
            </button>
          ) : null}

          {windowed.map((key) => (
            <TranscriptRow key={key} view={view} entryKey={key} query={query} />
          ))}

          {visibleKeys.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">
              {keys.length === 0 ? "Nothing here yet." : "No Entry matches."}
            </p>
          ) : null}

          <StickToBottom view={view} scroller={scroller} pinned={pinned} />
        </div>
      </div>

      {atBottom ? null : <NewEntriesPill onClick={toBottom} />}
    </div>
  );
}

/**
 * One row, subscribed to its own Entry.
 *
 * The indirection exists so that `TranscriptEntry` can keep its two-prop contract: this component
 * takes the view and the key, reads the Entry, and hands down only `{ entry, query }`.
 */
function TranscriptRow({ view, entryKey, query }: { view: AgentSessionView; entryKey: string; query: string }) {
  const entry = useEntry(view, entryKey);
  // A key with no Entry cannot happen while the transcript is append-only, but rendering nothing is
  // the right answer if it ever does.
  if (!entry) return null;
  return <TranscriptEntry entry={entry} query={query} />;
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
  scroller,
  pinned,
}: {
  view: AgentSessionView;
  scroller: RefObject<HTMLDivElement | null>;
  pinned: RefObject<boolean>;
}) {
  const [, setTick] = useState(0);

  useEffect(() => view.subscribeTranscript(() => setTick((tick) => tick + 1)), [view]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  return null;
}

/**
 * Offered only when the reader has scrolled away, because that is the only time it means anything.
 * It says "latest" rather than counting: `Entry` carries no seq, so "N new since you looked" is not
 * a number this front end can honestly produce.
 */
function NewEntriesPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-3 bottom-[calc(var(--composer-inset,0px)+1.5rem)] rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md"
    >
      jump to latest ↓
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

  return query === "" ? keys : filtered;
}
