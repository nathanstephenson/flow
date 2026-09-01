import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { Entry } from "@client/reduce.ts";
import type { AgentSessionView, AgentSessionViewRegistry, Chrome } from "@/store/contract.ts";
import { agentSessionViews } from "@/store/registry.ts";

/**
 * The components' side of the state contract: a registry in context, and the three hooks that read
 * the three snapshot surfaces.
 *
 * The split is the performance design, so it is worth restating where the components can see it. The
 * header subscribes to `chrome`, which is shallow-compared and therefore silent while text streams.
 * TranscriptView subscribes to `getKeys()`, whose array identity holds while entries merely grow.
 * Each row subscribes to its own `getEntry(key)`, and React bails out for every row whose Entry
 * object did not change — so a streamed snapshot re-renders exactly one row. Collapsing these back
 * into one snapshot would re-render the whole transcript twenty times a second.
 *
 * The registry itself is `agentSessionViews` from web/src/store/registry.ts — module-level and
 * ref-counted, because a view owned by a component is a view StrictMode disposes twice on mount. It
 * arrives through context rather than by direct import so a test can hand a component tree a
 * different one.
 */

const RegistryContext = createContext<AgentSessionViewRegistry | undefined>(undefined);

export function useRegistry(): AgentSessionViewRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error("useRegistry outside AgentSessionViewProvider");
  return registry;
}

export function AgentSessionViewProvider({
  registry = agentSessionViews,
  children,
}: {
  registry?: AgentSessionViewRegistry | undefined;
  children: ReactNode;
}) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/**
 * Acquires a view for as long as the calling component is mounted.
 *
 * The acquire is paired with exactly one release, in a layout effect rather than during render, so
 * StrictMode's mount → unmount → mount cannot leak a reference and pin a transport open. It is a
 * *layout* effect so the first snapshot is read before the browser paints, and the caller's
 * one-frame `undefined` never reaches the screen.
 */
export function useAgentSession(sessionId: string): AgentSessionView | undefined {
  const registry = useRegistry();
  const [view, setView] = useState<AgentSessionView | undefined>(undefined);

  useLayoutEffect(() => {
    setView(registry.acquire(sessionId));
    return () => {
      setView(undefined);
      registry.release(sessionId);
    };
  }, [registry, sessionId]);

  return view;
}

export function useChrome(view: AgentSessionView): Chrome {
  const subscribe = useCallback((listener: () => void) => view.subscribeChrome(listener), [view]);
  const snapshot = useCallback(() => view.getChrome(), [view]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function useTranscriptKeys(view: AgentSessionView): readonly string[] {
  const subscribe = useCallback((listener: () => void) => view.subscribeTranscript(listener), [view]);
  const snapshot = useCallback(() => view.getKeys(), [view]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * One row's Entry. Subscribed to the transcript rather than to a per-entry channel: the notify is
 * broadcast, but the snapshot an unchanged row returns is the same object it returned last frame, so
 * React re-renders only the row whose Entry the reducer replaced.
 */
export function useEntry(view: AgentSessionView, key: string): Entry | undefined {
  const subscribe = useCallback((listener: () => void) => view.subscribeTranscript(listener), [view]);
  const snapshot = useCallback(() => view.getEntry(key), [view, key]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Chrome for the Agent Sessions that currently have a pane, keyed by id.
 *
 * This exists to settle an old disagreement rather than to add a feature. `SessionSummary.status`
 * comes from a poll and can be two seconds stale, while `Chrome.status` is live, so after a Settle
 * the sidebar said one thing and the pane another until the next tick. An Agent Session with a pane
 * open already has a view, so the sidebar reads the live status for those and the polled one for the
 * rest.
 *
 * The ids are joined into the dependency key because an array literal is a new array every render.
 */
export function useOpenChrome(ids: readonly string[]): Record<string, Chrome> {
  const registry = useRegistry();
  const [chromes, setChromes] = useState<Record<string, Chrome>>({});
  const key = ids.join(" ");

  useEffect(() => {
    const open = key === "" ? [] : key.split(" ");
    const views = open.map((id) => registry.acquire(id));
    const read = (): void =>
      setChromes(Object.fromEntries(views.map((view) => [view.sessionId, view.getChrome()])));
    read();
    const unsubscribes = views.map((view) => view.subscribeChrome(read));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const id of open) registry.release(id);
    };
  }, [registry, key]);

  return chromes;
}
