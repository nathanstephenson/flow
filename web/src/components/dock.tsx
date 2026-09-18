import { Activity, lazy, Suspense, useCallback, useRef, useState } from "react";
import { Bot, PanelBottomClose, PanelRightClose, Plus, SquareTerminal, X } from "lucide-react";

import { dockSizeStep, tabLabel, type Dock as DockState, type DockSide, type DockTab } from "@/presentation/docks.ts";
import type { MobileDetail } from "@/presentation/mobile-navigation.ts";
import type { DockAction } from "@/docks.ts";
import { DockResizeHandle } from "@/components/dock-resize-handle.tsx";
import { GitPane } from "@/components/git-pane.tsx";
import { SubagentsPane } from "@/components/subagents-pane.tsx";
import { ShellPane, type ShellStatus } from "@/components/shell-pane.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

const WorkflowsPane = lazy(() => import("./workflows-pane.tsx"));

export type MobileDockNavigation = {
  tabId: string;
  detail: MobileDetail | undefined;
  onDetail: (detail: MobileDetail) => void;
  onBackDetail: () => void;
};

/**
 * One desktop Dock, or the body selected by the unified mobile tab row.
 *
 * Non-Shell tab bodies stay mounted while hidden. That is what preserves an unfinished Git publish,
 * Workflow input, or graph selection when a reader changes mobile views. Shells are the deliberate
 * exception: hiding one disconnects its renderer while its host pty continues running, exactly as
 * minimising a desktop Dock always has.
 */
export function Dock({
  side,
  dock,
  sessionId,
  shells,
  dispatch,
  visible = true,
  mobile = false,
  mobileNavigation,
}: {
  side: DockSide;
  dock: DockState;
  sessionId: string;
  shells: boolean;
  dispatch: (action: DockAction) => void;
  visible?: boolean;
  mobile?: boolean;
  mobileNavigation?: MobileDockNavigation;
}) {
  const root = useRef<HTMLElement>(null);
  const [statuses, setStatuses] = useState<Record<string, ShellStatus>>({});
  const noteStatus = useCallback((tabId: string, status: ShellStatus) => {
    setStatuses((current) => ({ ...current, [tabId]: status }));
  }, []);

  const activeId = mobileNavigation?.tabId ?? dock.activeId;
  const active = dock.tabs.find((tab) => tab.id === activeId);
  const label = side === "bottom" ? "bottom Dock" : "right Dock";
  const resize = (px: number, available?: number): void =>
    dispatch({ type: "resize", side, px, ...(available === undefined ? {} : { available }) });

  return (
    <section
      ref={root}
      data-dock={side}
      aria-label={label}
      className={cn(
        "relative min-h-0 min-w-0 bg-background",
        visible ? "grid" : "hidden",
        mobile
          ? "col-start-1 row-start-1 grid-rows-[minmax(0,1fr)]"
          : side === "bottom"
            ? "col-start-1 row-start-2 grid-rows-[auto_minmax(0,1fr)] border-t"
            : "col-start-2 row-span-2 row-start-1 grid-rows-[auto_minmax(0,1fr)] border-l",
      )}
    >
      {mobile ? null : (
        <>
          <DockResizeHandle
            side={side}
            size={dock.size}
            onResize={resize}
            onNudge={(direction, shiftKey) => {
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
                      title={tab.content?.kind === "shell" ? "Close this tab — ends its Shell" : "Close this tab"}
                      aria-label={`Close ${tabLabel(dock, tab.id)}${tab.content?.kind === "shell" ? " — ends its Shell" : ""}`}
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                );
              })}
            </div>

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
        </>
      )}

      <div className="relative min-h-0 min-w-0 overflow-hidden">
        {dock.tabs.length === 0 ? (
          <ContentPicker
            onChooseWorkflows={() => dispatch({ type: "open-workflows", side })}
            onChooseGit={() => dispatch({ type: "open-git", side })}
            onChooseSubagents={() => dispatch({ type: "open-subagents", side })}
            {...(shells ? { onChooseShell: () => dispatch({ type: "open-shell", side }) } : {})}
          />
        ) : (
          dock.tabs.map((tab) => (
            <DockTabPanel
              key={tab.id}
              side={side}
              tab={tab}
              active={tab.id === active?.id}
              visible={visible && tab.id === active?.id}
              sessionId={sessionId}
              shells={shells}
              dispatch={dispatch}
              onStatus={(status) => noteStatus(tab.id, status)}
              mobileNavigation={mobileNavigation?.tabId === tab.id ? mobileNavigation : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DockTabPanel({
  side,
  tab,
  active,
  visible,
  sessionId,
  shells,
  dispatch,
  onStatus,
  mobileNavigation,
}: {
  side: DockSide;
  tab: DockTab;
  active: boolean;
  visible: boolean;
  sessionId: string;
  shells: boolean;
  dispatch: (action: DockAction) => void;
  onStatus: (status: ShellStatus) => void;
  mobileNavigation?: MobileDockNavigation;
}) {
  const content = tab.content;
  return (
    <Activity mode={visible ? "visible" : "hidden"}>
      <div
        role="tabpanel"
        aria-hidden={!visible}
        className="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden"
      >
      {content?.kind === "workflows" ? (
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading workflows…</p>}>
          <WorkflowsPane
            key={sessionId}
            sessionId={sessionId}
            placement={side}
            mobileNavigation={mobileNavigation ? {
              stepId: mobileNavigation.detail?.kind === "workflow-step" ? mobileNavigation.detail.id : "",
              onSelect: (stepId) => mobileNavigation.onDetail({ kind: "workflow-step", id: stepId }),
              onBack: mobileNavigation.onBackDetail,
            } : undefined}
          />
        </Suspense>
      ) : content?.kind === "git" ? (
        <GitPane key={`${sessionId}-${tab.id}`} sessionId={sessionId} />
      ) : content?.kind === "subagents" ? (
        <SubagentsPane
          key={tab.id}
          sessionId={sessionId}
          subagentId={
            mobileNavigation
              ? mobileNavigation.detail?.kind === "subagent" ? mobileNavigation.detail.id : undefined
              : content.subagentId
          }
          onSelect={(subagentId) => {
            dispatch({ type: "select-subagent", side, tabId: tab.id, ...(subagentId ? { subagentId } : {}) });
            if (!mobileNavigation) return;
            if (subagentId) mobileNavigation.onDetail({ kind: "subagent", id: subagentId });
            else mobileNavigation.onBackDetail();
          }}
        />
      ) : content?.kind === "shell" ? (
        // Only the visible Shell owns a terminal/socket. Its pty keeps running while this is absent.
        active && visible ? (
          <ShellPane
            key={tab.id}
            sessionId={sessionId}
            shellId={content.shellId}
            onOpened={(shellId) => dispatch({ type: "remember-shell", side, tabId: tab.id, shellId })}
            onStatus={onStatus}
          />
        ) : null
      ) : (
        <ContentPicker
          onChooseWorkflows={() => dispatch({ type: "open-workflows", side, tabId: tab.id })}
          onChooseGit={() => dispatch({ type: "open-git", side, tabId: tab.id })}
          onChooseSubagents={() => dispatch({ type: "open-subagents", side, tabId: tab.id })}
          {...(shells ? { onChooseShell: () => dispatch({ type: "open-shell", side, tabId: tab.id }) } : {})}
        />
      )}
      </div>
    </Activity>
  );
}

function ContentPicker({
  onChooseWorkflows,
  onChooseShell,
  onChooseSubagents,
  onChooseGit,
}: {
  onChooseWorkflows: () => void;
  onChooseGit: () => void;
  onChooseShell?: () => void;
  onChooseSubagents: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-wrap items-center justify-center gap-2 overflow-auto p-4">
      {onChooseShell === undefined ? null : (
        <Button variant="outline" size="sm" className="max-lg:min-h-10" onClick={onChooseShell}>
          <SquareTerminal aria-hidden data-icon="inline-start" />
          Shell
        </Button>
      )}
      <Button variant="outline" size="sm" className="max-lg:min-h-10" onClick={onChooseGit}>Git</Button>
      <Button variant="outline" size="sm" className="max-lg:min-h-10" onClick={onChooseWorkflows}>Workflows</Button>
      <Button variant="outline" size="sm" className="max-lg:min-h-10" onClick={onChooseSubagents}>
        <Bot aria-hidden data-icon="inline-start" />
        Agents
      </Button>
    </div>
  );
}
