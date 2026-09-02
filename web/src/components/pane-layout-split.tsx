import { usePaneLayout } from "@/pane-layout.tsx";
import { AgentSessionPane } from "@/components/agent-session-pane.tsx";
import { Kbd } from "@/components/agent-session-sidebar.tsx";

/**
 * Master–detail with an optional two-up split: one focused Agent Session, or two side by side.
 *
 * This replaces an N-pane grid, and the loss is real — README advertises "several sessions open side
 * by side", and two is fewer than several. What two-up keeps is the thing the grid was actually used
 * for: comparing. What replaces the rest is the sidebar as a status board, which lets you *monitor*
 * any number without *reading* them. The grid also degraded past about four panes for a concrete
 * reason: browsers cap concurrent connections per origin, so six panes meant six long-lived event
 * streams starving the command endpoint.
 */
export function PaneLayoutSplit() {
  const layout = usePaneLayout();

  if (layout.primary === undefined) return <EmptyPaneLayout />;

  if (layout.mode === "split" && layout.secondary !== undefined) {
    return (
      <div className="grid min-h-0 grid-cols-2 gap-px bg-border">
        <AgentSessionPane sessionId={layout.primary} role="primary" />
        <AgentSessionPane sessionId={layout.secondary} role="secondary" />
      </div>
    );
  }

  return <AgentSessionPane sessionId={layout.primary} role="primary" />;
}

/**
 * Nothing selected. The copy is in the ubiquitous language — "session" on its own is banned as a
 * synonym for Agent Session, and this is the string that used to break that rule most visibly.
 */
export function EmptyPaneLayout() {
  return (
    <div className="flex min-h-0 items-center justify-center">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        Select an Agent Session, or press <Kbd>n</Kbd> to start one.
      </p>
    </div>
  );
}
