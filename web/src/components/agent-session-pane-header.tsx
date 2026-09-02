import { MoreHorizontal, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";

import type { EffortLevel } from "../../../src/protocol/events.ts";
import { contextUsageLabel } from "@client/context-usage.ts";
import { canRevive, canSettle } from "@client/status.ts";
import { useCommand } from "@/agent-sessions.tsx";
import type { Chrome } from "@/store/contract.ts";
import { ScopeLabel } from "@/components/agent-session-nav.tsx";
import { EffortPicker, ModelPicker } from "@/components/model-picker.tsx";
import { RunningHairline, StatusBadge } from "@/components/status-indicator.tsx";
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
import { toast } from "@/components/ui/toaster.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The instrument half of the pane: what this Agent Session is, and what can be done to it.
 *
 * Stock shadcn sans throughout and smaller than the transcript, so it stays legible without
 * competing with the document beside it. Mono survives only where character alignment is functional:
 * the Scope, the Agent Session id and the token counts, which are machine values a reader compares
 * character by character.
 *
 * Affordances are hidden rather than disabled when they cannot apply: Settle disappears once an Agent
 * Session is Settled or Ended, Effort disappears for a model with no Effort levels, and abort
 * disappears when no turn is running. A permanently greyed control teaches nothing.
 */
export type AgentSessionPaneHeaderProps = {
  sessionId: string;
  title: string;
  chrome: Chrome;
  /** Absent where the host cannot open a Shell, which is how the control disappears rather than breaks. */
  shell?: { open: boolean; onToggle: () => void };
};

export function AgentSessionPaneHeader({ sessionId, title, chrome, shell }: AgentSessionPaneHeaderProps) {
  const run = useCommand();

  return (
    <div className="bg-card text-card-foreground">
      <div className="flex min-h-9 flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="truncate text-sm font-medium">{title}</span>

        <StatusBadge status={chrome.status} />
        {chrome.backend === undefined ? null : <Badge>{chrome.backend}</Badge>}
        {chrome.queueDepth > 0 ? <SteeringQueueBadge depth={chrome.queueDepth} /> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <ContextUsageMeter usage={chrome.contextUsage} />

          {shell ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={shell.open ? "Hide the Shell" : "Open a Shell"}
                    aria-pressed={shell.open}
                    className={cn(shell.open && "bg-accent text-accent-foreground")}
                    onClick={shell.onToggle}
                  />
                }
              >
                <SquareTerminal aria-hidden />
              </TooltipTrigger>
              <TooltipContent>
                {shell.open ? "Hide the Shell — it keeps running" : "Open a Shell in this Scope"}
              </TooltipContent>
            </Tooltip>
          ) : null}

          <ModelPicker
            capabilities={chrome.capabilities}
            model={chrome.model}
            disabled={chrome.status === "ended"}
            onSelect={(modelId) => void run({ type: "set_model", sessionId, modelId })}
          />
          <EffortPicker
            capabilities={chrome.capabilities}
            model={chrome.model}
            effort={chrome.effort}
            disabled={chrome.status === "ended"}
            onSelect={(effort: EffortLevel) => void run({ type: "set_effort", sessionId, effort })}
          />

          {chrome.status === "running" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Abort the current turn"
                    onClick={() => {
                      const dropped = chrome.queueDepth;
                      void run({ type: "abort", sessionId }).then(() => {
                        // Aborting means stop, not stop-then-continue, so the queue goes with it.
                        // Saying exactly what was discarded is the difference between a stop and a
                        // surprise.
                        toast.info(
                          dropped > 0
                            ? `aborted · ${dropped} queued message${dropped === 1 ? "" : "s"} discarded`
                            : "aborted",
                        );
                      });
                    }}
                  />
                }
              >
                <Square aria-hidden />
              </TooltipTrigger>
              <TooltipContent>
                Abort the current turn — this also discards the Steering Queue
              </TooltipContent>
            </Tooltip>
          ) : null}

          {canSettle(chrome.status) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void run({ type: "settle", sessionId }).then(() => {
                  /*
                   * No undo button, deliberately. Undoing a Settle means a Revive, which starts a
                   * Backend Session and spends money — so the toast states the reversal rather than
                   * offering to perform it. That sentence is ADR 0006 and ADR 0003 in the UI at no
                   * cost.
                   */
                  toast.info("Settled — the next message Revives it.");
                });
              }}
            >
              settle
            </Button>
          ) : null}

          <PaneOverflowMenu sessionId={sessionId} chrome={chrome} />
        </div>

        <div className="flex w-full items-center gap-2">
          <ScopeLabel scope={chrome.scope ?? ""} className="max-w-[28rem]" />
          <span className="truncate font-mono text-xs text-muted-foreground">{sessionId}</span>
        </div>
      </div>

      {/* Directly under the header, spanning it: the one animation in the app. */}
      <RunningHairline running={chrome.status === "running"} />
    </div>
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
 * How much of the Conversation Context is spent. The wording comes from the shared label so the TUI
 * and this UI cannot drift on it again — they said `context 12%` and `12% context` for the same
 * numbers.
 */
function ContextUsageMeter({ usage }: { usage: Chrome["contextUsage"] }) {
  const label = contextUsageLabel(usage);
  if (label === undefined) return null;
  const fraction = usage && usage.window > 0 ? Math.min(1, usage.used / usage.window) : undefined;

  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      {fraction === undefined ? null : (
        <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
          {/*
           * Two steps, not three. The middle one was `--chart-4`, which rhea renders as a grey the
           * eye cannot separate from `--primary` on a 6px bar — so it encoded nothing. The bar's
           * *length* and the percentage beside it carry the value; the only thing worth a colour is
           * a window about to overflow, which is a real failure ahead and gets `--destructive`.
           * The width has to stay an inline style: it is a runtime percentage, not a class.
           */}
          <span
            className={cn("block h-full", fraction > 0.9 ? "bg-destructive" : "bg-primary")}
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      )}
    </span>
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
