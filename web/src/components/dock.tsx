import { useCallback, useRef, useState } from "react";
import { Bot, PanelBottomClose, PanelRightClose, Plus, SquareTerminal, X } from "lucide-react";

import { dockSizeStep, tabLabel, type Dock as DockState, type DockSide } from "@/presentation/docks.ts";
import type { DockAction } from "@/docks.ts";
import { DockResizeHandle } from "@/components/dock-resize-handle.tsx";
import { SubagentsPane } from "@/components/subagents-pane.tsx";
import { ShellPane, type ShellStatus } from "@/components/shell-pane.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * One Dock: a tabs row, a body, and a splitter along its leading edge.
 *
 * A Dock is Open or Minimised and nothing else. There is no "empty" state, which is why the body
 * falls back to the content picker rather than the Dock collapsing when its last tab closes: the
 * button that opened it would otherwise appear not to work.
 *
 * Only the active tab is mounted. An inactive tab's Shell keeps running with its socket closed, and
 * switching back reattaches and replays the Scrollback — the same thing minimising does, for the
 * same reason: two Ghostty canvases painting a screen nobody is looking at is a render loop each.
 * The cost is that an exited Shell keeps its last screen only while its tab stays active: the Session
 * Host forgets a Shell as it dies, so there is nothing to reattach to afterwards, and the tab says
 * "disconnected" over an empty terminal until it is closed.
 *
 * `×` on a tab ends its Shell. That reverses what the old close button promised, and it is the point:
 * a tab is a Shell's only handle now, so a tab that merely hid one would leave a pty running with
 * nothing on screen pointing at it (ADR 0008).
 */
export function Dock({
  side,
  dock,
  sessionId,
  shells,
  dispatch,
}: {
  side: DockSide;
  dock: DockState;
  sessionId: string;
  /** Whether this host can open a Shell. The Dock itself is offered either way. */
  shells: boolean;
  dispatch: (action: DockAction) => void;
}) {
  const root = useRef<HTMLElement>(null);

  /*
   * Why each tab's screen stopped, if it has.
   *
   * Transient on purpose. The Session Host forgets a Shell the moment it exits, so this cannot be
   * reconstructed after a reload — and it does not need to be, because the reconcile on arrival
   * drops the tab of a Shell that is gone. What it buys is the tab you are looking at: an exited
   * Shell keeps its last screen and its label says why, until you close it.
   */
  const [statuses, setStatuses] = useState<Record<string, ShellStatus>>({});
  const noteStatus = useCallback((tabId: string, status: ShellStatus) => {
    setStatuses((current) => ({ ...current, [tabId]: status }));
  }, []);

  const active = dock.tabs.find((tab) => tab.id === dock.activeId);
  const label = side === "bottom" ? "bottom Dock" : "right Dock";

  const resize = (px: number, available?: number): void =>
    dispatch({ type: "resize", side, px, ...(available === undefined ? {} : { available }) });

  return (
    <section
      ref={root}
      data-dock={side}
      aria-label={label}
      className={cn(
        "relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-background",
        side === "bottom" ? "border-t" : "border-l",
      )}
    >
      <DockResizeHandle
        side={side}
        size={dock.size}
        onResize={resize}
        onNudge={(direction, shiftKey) => {
          // The frame is what the size is a share of, so the clamp needs its extent — measured here
          // rather than passed down, because only the DOM knows it.
          const frame = root.current?.closest<HTMLElement>("[data-dock-frame]");
          const available = frame === null || frame === undefined
            ? undefined
            : side === "bottom"
              ? frame.clientHeight
              : frame.clientWidth;
          resize(dock.size + direction * dockSizeStep(shiftKey), available);
        }}
      />

      <div className="flex h-9 min-w-0 items-center gap-1 border-b px-1.5">
        <div
          role="tablist"
          aria-label={`${label} tabs`}
          aria-orientation="horizontal"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {dock.tabs.map((tab) => {
            const status = statuses[tab.id];
            return (
              <div
                key={tab.id}
                className={cn(
                  "flex shrink-0 items-center gap-0.5 rounded-2xl pr-0.5 pl-2.5 text-xs",
                  tab.id === dock.activeId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                <button
                  type="button"
                  // Not a Button: this is a tab, so it says so, and its selected state is the one
                  // thing a reader needs the assistive tree to carry.
                  role="tab"
                  aria-selected={tab.id === dock.activeId}
                  onClick={() => dispatch({ type: "activate", side, tabId: tab.id })}
                  className="max-w-40 truncate py-1 outline-none"
                >
                  {tabLabel(dock, tab.id)}
                  {status?.state === "gone" ? (
                    <span className="ml-1.5 text-muted-foreground">{status.why}</span>
                  ) : null}
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-xl"
                  onClick={() => dispatch({ type: "close-tab", side, tabId: tab.id })}
                  // Says what it does. The honest answer is "ends it", and this is the only control
                  // in the app that ends a Shell.
                  title="Close this tab — ends its Shell"
                  aria-label={`Close ${tabLabel(dock, tab.id)} — ends its Shell`}
                >
                  <X aria-hidden />
                </Button>
              </div>
            );
          })}
        </div>

        {/* Outside the tablist, which may only contain tabs — and it keeps `+` in place rather than
            letting it scroll away once there are more tabs than fit. */}
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 rounded-xl"
          onClick={() => dispatch({ type: "add-tab", side })}
          title="New tab"
          aria-label={`New tab in the ${label}`}
        >
          <Plus aria-hidden />
        </Button>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 rounded-xl"
                onClick={() => dispatch({ type: "toggle", side })}
                aria-label={`Minimise the ${label}`}
              />
            }
          >
            {side === "bottom" ? <PanelBottomClose aria-hidden /> : <PanelRightClose aria-hidden />}
          </TooltipTrigger>
          <TooltipContent>Minimise — Shells keep running</TooltipContent>
        </Tooltip>
      </div>

      {active?.content?.kind === "subagents" ? (
        <SubagentsPane
          key={active.id}
          sessionId={sessionId}
          subagentId={active.content.subagentId}
          onSelect={(subagentId) =>
            dispatch({ type: "select-subagent", side, tabId: active.id, ...(subagentId ? { subagentId } : {}) })
          }
        />
      ) : active?.content?.kind === "shell" ? (
        <ShellPane
          // Keyed by the tab, not by the Shell: the id arrives after the pty is spawned, and keying
          // on it would tear down the terminal that had just reported it.
          key={active.id}
          sessionId={sessionId}
          shellId={active.content.shellId}
          onOpened={(shellId) => dispatch({ type: "remember-shell", side, tabId: active.id, shellId })}
          onStatus={(status) => noteStatus(active.id, status)}
        />
      ) : (
        <ContentPicker
          onChooseSubagents={() =>
            dispatch({ type: "open-subagents", side, ...(active ? { tabId: active.id } : {}) })
          }
          {...(shells
            ? {
                onChooseShell: () =>
                  dispatch({ type: "open-shell", side, ...(active ? { tabId: active.id } : {}) }),
              }
            : {})}
        />
      )}
    </section>
  );
}

/**
 * What a Dock shows when its active tab has no content yet — which is also what it shows when it has
 * no tabs at all, because those are the same question.
 *
 * A list rather than a menu because it is the body of the Dock, not a popover hanging off `+`:
 * filling the space is what makes an empty Dock explain itself.
 *
 * A Shell is offered only where the host can open one. The Docks used to be withheld entirely on
 * that basis, which meant anything else they could hold was withheld with them.
 */
function ContentPicker({
  onChooseShell,
  onChooseSubagents,
}: {
  onChooseShell?: () => void;
  onChooseSubagents: () => void;
}) {
  return (
    <div className="flex min-h-0 items-center justify-center gap-2 overflow-auto p-4">
      {onChooseShell === undefined ? null : (
        <Button variant="outline" size="sm" onClick={onChooseShell}>
          <SquareTerminal aria-hidden data-icon="inline-start" />
          Shell
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onChooseSubagents}>
        <Bot aria-hidden data-icon="inline-start" />
        Agents
      </Button>
    </div>
  );
}
