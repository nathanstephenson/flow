import { MoreHorizontal, PanelBottom, PanelRight } from "lucide-react";
import { useState } from "react";

import { canRevive } from "@client/status.ts";
import { useCommand } from "@/agent-sessions.tsx";
import type { Docks } from "@/docks.ts";
import type { DockSide } from "@/presentation/docks.ts";
import type { Chrome } from "@/store/contract.ts";
import { RunningHairline } from "@/components/status-indicator.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * What this Agent Session *is*, and what can be done to it as a whole.
 *
 * The line it draws with the Composer: anything describing the *next turn* belongs down there, which
 * is why the model, the Effort level, the Conversation Context meter and abort all left. What stays
 * is identity and lifecycle — one line of `<Project> | <title>`, the Docks and the overflow.
 *
 * The backend is not among them: the tab already names it, and a second copy costs a row of the
 * transcript's height to repeat something already on screen. Naming it was what forced this header
 * onto two rows; one line is the whole of what identity needs.
 *
 * The branch is deliberately *not* among them, though it was here first. It reads like identity, but
 * what the control is for is the edits the next message will cause — so it belongs with the rest of
 * "what this turn will do", and it lives on the composer's Scope Strip. What stayed behind is the
 * Project name, which for a Worktree Scope has to be read one path segment further up; see
 * `projectName`.
 *
 * Status is not among them: the rail already draws it for every Agent Session, including this one,
 * and a second copy over the transcript says nothing the reader cannot already see. The Agent Session
 * id is not either — it identifies nothing to a human, and the overflow menu copies it on request.
 *
 * Stock shadcn sans throughout and smaller than the transcript, so it stays legible without
 * competing with the document beside it. Mono survives only where character alignment is functional:
 * the Project name, which is a filesystem name.
 *
 * Affordances are hidden rather than disabled when they cannot apply. A permanently greyed control
 * teaches nothing.
 */
export type AgentSessionPaneHeaderProps = {
  sessionId: string;
  title: string;
  chrome: Chrome;
  /** Absent where the host cannot open a Shell, which is how the controls disappear rather than break. */
  docks?: Docks;
};

export function AgentSessionPaneHeader({ sessionId, title, chrome, docks }: AgentSessionPaneHeaderProps) {
  return (
    <div className="bg-card text-card-foreground">
      <div className="flex min-h-9 items-center gap-2 border-b px-3 py-2">
        <span className="shrink-0 font-mono text-xs">{projectName(chrome.scope ?? "", chrome.worktree)}</span>
        <span className="-my-2 w-px shrink-0 self-stretch bg-border" aria-hidden />
        <span className="truncate text-sm font-medium">{title}</span>

        {chrome.queueDepth > 0 ? <SteeringQueueBadge depth={chrome.queueDepth} /> : null}

        <div className="ml-auto flex items-center gap-1.5">
          {docks ? (
            <>
              <DockToggle side="bottom" docks={docks} />
              <DockToggle side="right" docks={docks} />
            </>
          ) : null}

          <PaneOverflowMenu sessionId={sessionId} chrome={chrome} />
        </div>
      </div>

      {/* Directly under the header, spanning it: the one animation in the app. */}
      <RunningHairline running={chrome.status === "running"} />
    </div>
  );
}

/**
 * The segment of a Scope a reader would call the Project.
 *
 * The leading directories are dropped rather than dimmed: they are the same for every Agent Session
 * on this machine, so they cost a line's width to say nothing. A Scope that leaves no segment (`/`,
 * or a trailing slash) falls back to the Scope verbatim, because an empty header names nothing.
 *
 * **A worktree Scope is the exception, and it is the same rule rather than a new one.** That
 * premise above — that the leading directories say nothing because they are shared — is false for a
 * worktree: it ends `<repo>/<branch>`, so its parent is the repository and is the one segment worth
 * reading, while its basename is the branch the control beside this already names. So the same
 * question is asked one segment higher up. A flag rather than the repository's name over the wire,
 * because the name is already here in the Scope.
 */
function projectName(scope: string, worktree?: true): string {
  const path = worktree ? scope.slice(0, Math.max(0, scope.lastIndexOf("/"))) : scope;
  const cut = path.lastIndexOf("/");
  return (cut < 0 ? path : path.slice(cut + 1)) || scope;
}

/**
 * Show or minimise one Dock.
 *
 * Two buttons rather than one menu: which side a Dock is on is the whole of what distinguishes them,
 * and that is a thing an icon can say. Minimising is not closing — the Shells inside keep running —
 * so the copy says so rather than borrowing the word "close" from the tab that does end one.
 */
function DockToggle({ side, docks }: { side: DockSide; docks: Docks }) {
  const open = !docks.layout[side].minimised;
  const label = side === "bottom" ? "bottom Dock" : "right Dock";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${open ? "Minimise" : "Open"} the ${label}`}
            aria-pressed={open}
            className={cn(open && "bg-accent text-accent-foreground")}
            onClick={() => docks.dispatch({ type: "toggle", side })}
          />
        }
      >
        {side === "bottom" ? <PanelBottom aria-hidden /> : <PanelRight aria-hidden />}
      </TooltipTrigger>
      <TooltipContent>
        {open ? `Minimise the ${label} — Shells keep running` : `Open the ${label}`}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The Steering Queue's depth. `secondary` rather than a warn hue: rhea has no warn hue, and a queued
 * message is not a problem — it is the Session Host doing what it promised.
 */
function SteeringQueueBadge({ depth }: { depth: number }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" />}>{depth} queued</TooltipTrigger>
      <TooltipContent>
        Messages the Session Host has accepted and will send after the current turn
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Everything that is not a primary action.
 *
 * The Revive lives here and only here (ADR 0003): the composer already Revives, a second affordance
 * for one act is how a confirm dialog gets born, and it must never fire on mount or on focus, because
 * a Revive silently spends money and edits files.
 *
 * Compaction and fork are declared on `Capabilities` but there is no `Command` for either, so they
 * are not offered at all rather than offered and broken. The slot is here when the protocol grows
 * them, and the rule when it does is the Effort rule: hide what this Agent Session cannot serve.
 */
function PaneOverflowMenu({ sessionId, chrome }: { sessionId: string; chrome: Chrome }) {
  const run = useCommand();
  const [confirmEnd, setConfirmEnd] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" aria-label="More actions">
              <MoreHorizontal aria-hidden />
            </Button>
          }
        />
        {/*
         * Upstream's content is `w-(--anchor-width)` so it matches the trigger, and the trigger here
         * is a 32px icon button — which would wrap every item onto three lines. `min-w-56` beats the
         * `min-w-32` upstream floors it at without fighting the anchor width.
         */}
        <DropdownMenuContent className="min-w-56">
          {canRevive(chrome.status) ? (
            <DropdownMenuItem onClick={() => void run({ type: "revive", sessionId })}>
              Revive this Agent Session
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(sessionId)}>
            Copy Agent Session id
          </DropdownMenuItem>
          {chrome.status === "ended" ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmEnd(true)}>
                End Agent Session…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <AlertDialogContent>
          {/*
           * The app's only confirm. The copy avoids "close", "archive", "done" and "finished" — all
           * banned as synonyms for Settled — and it does not say "Settle", because this is the other
           * thing. It also does not imply the Agent Session disappears: an Ended one is never Reaped,
           * so it stays on disk and stays readable until somebody removes it by hand.
           */}
          <AlertDialogHeader>
            <AlertDialogTitle>End Agent Session</AlertDialogTitle>
            <AlertDialogDescription>
              No Backend Session will run and this one will refuse a Revive. Its Presentation
              Transcript stays readable and stays on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Cancel is upstream's Close; Action deliberately is *not*, so it closes explicitly. */}
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmEnd(false);
                void run({ type: "dispose", sessionId });
              }}
            >
              End Agent Session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
