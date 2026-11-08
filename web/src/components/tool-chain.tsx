import { Layers, LoaderCircle } from "lucide-react";
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { isToolKey } from "@client/tool-chains.ts";
import { toolSummary } from "@client/tool-summary.ts";
import { useEntry } from "@/agent-session-view.tsx";
import { ToolIcon } from "@/components/tool-icon.tsx";
import type { AgentSessionView } from "@/store/contract.ts";
import { backgroundKeyOf } from "@/presentation/background-rows.ts";

/**
 * A Tool Chain: two or more adjacent tool calls, as one line.
 *
 * Twelve greps in a row are twelve cards between the reader and the prose that follows, and eleven
 * of them say the same thing. So the run collapses to the two facts worth carrying — how many ran,
 * and what the latest one is — and the cards live behind a disclosure.
 *
 * **Nothing is unmounted.** `<details>` keeps its content in the DOM, so every member is still there
 * to be found: Cmd-F reaches inside and the browser opens the chain around the hit. That is the same
 * rule the thinking clamp follows and the reason `transcript-view.tsx` refuses to virtualise — ADR
 * 0001's record of what a human saw is not something a presentation choice gets to trim. Native
 * `<details>` for the rest of `ToolCallEntryView`'s reasons, too: the state survives in the DOM of a
 * list that never unmounts, and it is keyboard-accessible without a line of code.
 *
 * It opens for nobody. A failed member does not force it: the header names the failure, and the
 * failed card inside auto-opens itself, so one click lands on it. A chain that flew open every time
 * a grep missed would be a chain that is never closed.
 */
export function ToolChain({
  view,
  keys,
  children,
}: {
  view: AgentSessionView;
  keys: readonly string[];
  children: ReactNode;
}) {
  // A chain carries the thinking between its calls, but the header speaks about tools: it counts
  // them and names the last one, so a trailing thought does not leave the line anonymous.
  const toolKeys = useMemo(() => keys.filter(isToolKey), [keys]);
  const calls = keys.filter((key) => isToolKey(key) || key.startsWith("background_call:")).length;
  // One hook, not one per member: a chain grows as tools land, and a hook per key would change the
  // hook count between renders.
  const latest = useEntry(view, toolKeys[toolKeys.length - 1] ?? "");
  const failed = useChainFailures(view, keys);
  const inBackground = useChainBackgroundRunning(view, toolKeys);
  const precis = latest?.kind === "tool" ? toolSummary(latest.input) : undefined;

  return (
    <details className="text-foreground">
      <summary className="-mx-1.5 flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 select-none hover:bg-muted/50">
        <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-sm text-muted-foreground">{calls} tools</span>
        {latest?.kind === "tool" ? (
          <>
            <span className="shrink-0 text-muted-foreground/60" aria-hidden>
              ·
            </span>
            <ToolIcon name={latest.name} className="text-muted-foreground" />
            <span className="shrink-0 text-sm text-muted-foreground">{latest.name}</span>
            {precis === undefined ? null : (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/80">{precis}</span>
            )}
          </>
        ) : null}
        {failed > 0 ? (
          <span className="ml-auto shrink-0 text-xs text-destructive">{failed} failed</span>
        ) : (latest?.kind === "tool" && latest.status === "running") || inBackground > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
            {inBackground > 0 ? `${inBackground} in background` : <span className="sr-only">running</span>}
          </span>
        ) : null}
      </summary>

      <div className="mt-0.5 ml-3 border-l pl-2">{children}</div>
    </details>
  );
}

/**
 * How many of a chain's members failed.
 *
 * A **number**, deliberately. `useSyncExternalStore` compares snapshots by identity and calls
 * `getSnapshot` twice per render to check for tearing, so a snapshot that built a fresh object each
 * time would loop forever. A primitive has none of that problem and is the whole of what the header
 * needs.
 */
function useChainFailures(view: AgentSessionView, keys: readonly string[]): number {
  const subscribe = useCallback((listener: () => void) => view.subscribeTranscript(listener), [view]);
  const snapshot = useCallback(() => {
    let failed = 0;
    for (const key of keys) {
      const entry = view.getEntry(key);
      if (entry?.kind === "tool" && entry.status === "error") failed += 1;
    }
    return failed;
  }, [view, keys]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * How many of a chain's tool calls are still running in the background. Their rows are inside the
 * closed chain, and this is what keeps "not finished" on screen (ADR 0021). A number, for the reason
 * `useChainFailures` gives.
 */
function useChainBackgroundRunning(view: AgentSessionView, toolKeys: readonly string[]): number {
  const subscribe = useCallback((listener: () => void) => view.subscribeTranscript(listener), [view]);
  const snapshot = useCallback(() => {
    let running = 0;
    for (const key of toolKeys) {
      const entry = view.getEntry(backgroundKeyOf(key));
      if (entry?.kind === "background_call" && entry.status === "running") running += 1;
    }
    return running;
  }, [view, toolKeys]);
  return useSyncExternalStore(subscribe, snapshot);
}
