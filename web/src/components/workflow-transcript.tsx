import { ArrowDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { reduceAll } from "../../../src/client/reduce.ts";
import type { LoggedEvent } from "../../../src/protocol/events.ts";
import type { WorkflowActivity, WorkflowActivityPage } from "../../../src/protocol/workflow-executions.ts";
import { isPinned } from "../presentation/stick-to-bottom.ts";
import { entryKey } from "../presentation/entry-key.ts";
import { pollAfterInitialLoad } from "../presentation/workflow-transcript-polling.ts";
import { TranscriptEntry } from "./transcript-entry.tsx";
import { workflowApi } from "./workflow-api.ts";
import { Button } from "./ui/button.tsx";

const PAGE_SIZE = 100;
const POLL_MS = 2_000;

/**
 * One Workflow Step attempt's retained transcript.
 *
 * It opens from the tail, then has two independent directions: an explicit backward page when the
 * reader asks for one, and a forward cursor that polls while the attempt is live. Sequence-based
 * merging makes reconnects and overlapping pages idempotent. The scroller uses the same pin rule as
 * the parent transcript: output follows only while the reader is already at the bottom.
 */
export function WorkflowTranscript({ base, sessionId, stepId, attempt, legacy, completed }: { base: string; sessionId: string; stepId: string; attempt: number; legacy: boolean; completed: boolean }) {
  const query = `stepId=${encodeURIComponent(stepId)}${legacy ? "" : `&attempt=${attempt}`}`;
  const [activity, setActivity] = useState<WorkflowActivity[]>([]);
  const events = useRef<WorkflowActivity[]>([]);
  const [previous, setPrevious] = useState<number>();
  const [historyComplete, setHistoryComplete] = useState(!legacy);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [generation, retry] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const restore = useRef<{ height: number; top: number } | undefined>(undefined);
  const olderRequest = useRef<AbortController | undefined>(undefined);
  const completedRef = useRef(completed);
  completedRef.current = completed;
  const finishPolling = useRef<(() => void) | undefined>(undefined);

  const merge = useCallback((incoming: WorkflowActivity[]) => {
    if (!incoming.length) return;
    const bySequence = new Map(events.current.map(item => [item.sequence, item]));
    for (const item of incoming) bySequence.set(item.sequence, item);
    const next = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    events.current = next;
    setActivity(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let initialLoading = true;
    let polling = false;
    let catchUpRequested = false;
    events.current = [];
    setActivity([]);
    setPrevious(undefined);
    setHistoryComplete(!legacy);
    setLoadingOlder(false);
    olderRequest.current?.abort();
    olderRequest.current = undefined;
    restore.current = undefined;
    setLoading(true);
    setError("");
    pinned.current = true;
    setAtBottom(true);

    const read = async (path: string) => workflowApi<WorkflowActivityPage>(path, "GET", undefined, controller.signal);
    const poll = async (): Promise<void> => {
      if (stopped || polling) { catchUpRequested = true; return; }
      polling = true;
      let failed = false;
      try {
        do {
          catchUpRequested = false;
          const after = events.current.at(-1)?.sequence ?? 0;
          const page = await read(`${base}/activity?${query}&after=${after}&limit=${PAGE_SIZE}`);
          merge(page.activity);
          setHistoryComplete(page.historyComplete);
          setError("");
          if (page.next !== undefined) catchUpRequested = true;
        } while (!stopped && catchUpRequested);
      } catch (reason) {
        failed = true;
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        polling = false;
      }
      if (!stopped && (!completedRef.current || failed)) timer = setTimeout(() => void poll(), POLL_MS);
    };
    finishPolling.current = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      catchUpRequested = true;
      if (!initialLoading) void poll();
    };

    void read(`${base}/activity?${query}&latest=true&limit=${PAGE_SIZE}`).then(page => {
      if (stopped) return;
      merge(page.activity);
      setPrevious(page.previous);
      setHistoryComplete(page.historyComplete);
      setLoading(false);
      initialLoading = false;
      // The next paint starts at current activity rather than making the reader page forward to it.
      requestAnimationFrame(() => {
        const element = scroller.current;
        if (element) element.scrollTop = element.scrollHeight;
      });
      if (pollAfterInitialLoad(completedRef.current, catchUpRequested)) void poll();
    }).catch(reason => {
      initialLoading = false;
      if (!controller.signal.aborted) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });

    return () => {
      stopped = true;
      finishPolling.current = undefined;
      controller.abort();
      olderRequest.current?.abort();
      olderRequest.current = undefined;
      if (timer) clearTimeout(timer);
    };
  }, [base, query, legacy, generation, merge]);

  useEffect(() => {
    if (completed) finishPolling.current?.();
  }, [completed]);

  const loadOlder = useCallback(async () => {
    const before = events.current[0]?.sequence;
    if (before === undefined || loadingOlder || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    try {
      const page = await workflowApi<WorkflowActivityPage>(`${base}/activity?${query}&before=${before}&limit=${PAGE_SIZE}`, "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      const element = scroller.current;
      if (element) restore.current = { height: element.scrollHeight, top: element.scrollTop };
      merge(page.activity);
      setPrevious(page.previous);
      setHistoryComplete(page.historyComplete);
      setError("");
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = undefined;
        setLoadingOlder(false);
      }
    }
  }, [base, query, loadingOlder, merge]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const saved = restore.current;
    if (element && saved) {
      element.scrollTop = saved.top + element.scrollHeight - saved.height;
      restore.current = undefined;
      return;
    }
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [activity]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      pinned.current = isPinned(element);
      if (throttle) return;
      throttle = setTimeout(() => {
        throttle = undefined;
        setAtBottom(pinned.current);
      }, 100);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (throttle) clearTimeout(throttle);
    };
  }, []);

  const transcript = useMemo(() => reduceAll(activity.flatMap(item => item.event.type === "spend" ? [] : [{
    sessionId,
    seq: item.sequence,
    at: new Date(item.at).toISOString(),
    event: item.event,
  } as LoggedEvent])), [activity, sessionId]);
  const entries = transcript.entries;
  const compacting = !completed && transcript.compacting === true;

  const toLatest = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setAtBottom(true);
  }, []);

  return (
    <section className="relative mt-3 min-w-0 overflow-hidden rounded-lg border bg-background" aria-label="Step transcript">
      <div ref={scroller} className="max-h-[32rem] min-h-32 overflow-auto px-2 py-2">
        {previous !== undefined ? (
          <Button size="sm" variant="ghost" className="mb-2 w-full text-muted-foreground" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {loadingOlder ? "Loading older activity…" : "Load older activity"}
          </Button>
        ) : null}
        {(legacy || historyComplete === false) ? (
          <p className="mb-2 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
            Older history is unavailable. Showing retained activity; legacy events may not identify their attempt.
          </p>
        ) : null}
        {loading && !entries.length ? (
          <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />Loading latest activity…</p>
        ) : null}
        {error ? (
          <div className="flex items-center justify-between gap-2 p-2 text-xs text-destructive" role="alert">
            <span>{entries.length ? `Connection lost. Reconnecting… ${error}` : error}</span>
            {!entries.length ? <Button size="sm" variant="outline" onClick={() => retry(value => value + 1)}>Retry</Button> : null}
          </div>
        ) : null}
        {entries.map(entry => <TranscriptEntry key={entryKey(entry)} entry={entry} query="" sessionId={sessionId} />)}
        {compacting ? (
          <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground" role="status" data-testid="workflow-compacting">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />Compacting context…
          </p>
        ) : null}
        {!loading && !entries.length && !compacting && !error ? <p className="p-2 text-xs text-muted-foreground">No activity recorded for this attempt.</p> : null}
      </div>
      {!atBottom && activity.length ? (
        <button type="button" onClick={toLatest} aria-label="Jump to latest Workflow activity" className="absolute right-3 bottom-3 rounded-full border bg-popover p-2 text-popover-foreground shadow-md hover:bg-muted">
          <ArrowDown className="size-4" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}
