import { AgentSessionViewProvider } from "@/agent-session-view.tsx";
import { SessionsProvider } from "@/agent-sessions.tsx";
import { HostProvider } from "@/host.tsx";
import { PaneLayoutProvider } from "@/pane-layout.tsx";
import { AppShell } from "@/components/app-shell.tsx";
import { Toaster } from "@/components/ui/toaster.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";

/**
 * The provider stack, in dependency order.
 *
 * `HostProvider` is outermost because everything below it needs the Connection, and because it is the
 * one that renders the unauthorised page instead of the app — a 401 must not mount a tree that
 * immediately starts polling and subscribing against a host that will refuse it.
 *
 * Note what is *not* here: no transcript state. A provider that re-renders twenty times a second
 * re-renders its entire subtree, which is exactly why the per-Agent-Session views are reached
 * through a registry and subscribed to leaf by leaf instead.
 */
export function App() {
  return (
    <HostProvider>
      <SessionsProvider>
        <AgentSessionViewProvider>
          <PaneLayoutProvider>
            <TooltipProvider>
              <AppShell />
              <Toaster />
            </TooltipProvider>
          </PaneLayoutProvider>
        </AgentSessionViewProvider>
      </SessionsProvider>
    </HostProvider>
  );
}
