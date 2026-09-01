import { Columns2, MoreHorizontal, Square, X } from "lucide-react";
import { useState } from "react";

import type { EffortLevel } from "../../../src/protocol/events.ts";
import { contextUsageLabel } from "@client/context-usage.ts";
import { canRevive, canSettle } from "@client/status.ts";
import { useCommand } from "@/agent-sessions.tsx";
import type { Chrome } from "@/store/contract.ts";
import { ScopeLabel } from "@/components/agent-session-sidebar.tsx";
import { EffortPicker, ModelPicker } from "@/components/model-picker.tsx";
import { RunningHairline, StatusBadge } from "@/components/status-indicator.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { toast } from "@/components/ui/toaster.tsx";
import { Tooltip } from "@/components/ui/tooltip.tsx";

/**
 * The instrument half of the pane: what this Agent Session is, and what can be done to it.
 *
 * Sans throughout and smaller than the transcript, so it stays legible without competing with the
 * document beside it. Every value that is verbatim — the Scope, the model id, the token counts — is
 * still mono, because those are machine values a reader compares character by character.
 *
 * Affordances are hidden rather than disabled when they cannot apply: Settle disappears once an Agent
 * Session is Settled or Ended, Effort disappears for a model with no Effort levels, and abort
 * disappears when no turn is running. A permanently greyed control teaches nothing.
 */
export type AgentSessionPaneHeaderProps = {
  sessionId: string;
  title: string;
  chrome: Chrome;
  splitOpen: boolean;
  closable: boolean;
  onToggleSplit: () => void;
  onClose: () => void;
};

export function AgentSessionPaneHeader({
  sessionId,
  title,
  chrome,
  splitOpen,
  closable,
  onToggleSplit,
  onClose,
}: AgentSessionPaneHeaderProps) {
  const run = useCommand();

  return (
    <div className="bg-(--color-surface)">
      <div className="flex min-h-9 flex-wrap items-center gap-2 border-b border-(--color-line) px-3 py-1.5">
        <span className="truncate font-sans text-sm font-medium text-(--color-fg-strong)">{title}</span>

        <StatusBadge status={chrome.status} />
        {chrome.backend === undefined ? null : <Badge>{chrome.backend}</Badge>}
        {chrome.queueDepth > 0 ? <SteeringQueueBadge depth={chrome.queueDepth} /> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <ContextUsageMeter usage={chrome.contextUsage} />

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
            <Tooltip label="Abort the current turn — this also discards the Steering Queue">
              <Button
                variant="quiet"
                size="icon"
                aria-label="Abort the current turn"
                onClick={() => {
                  const dropped = chrome.queueDepth;
                  void run({ type: "abort", sessionId }).then(() => {
                    // Aborting means stop, not stop-then-continue, so the queue goes with it. Saying
                    // exactly what was discarded is the difference between a stop and a surprise.
                    toast.info(
                      dropped > 0
                        ? `aborted · ${dropped} queued message${dropped === 1 ? "" : "s"} discarded`
                        : "aborted",
                    );
                  });
                }}
              >
                <Square size={10} aria-hidden />
              </Button>
            </Tooltip>
          ) : null}

          {canSettle(chrome.status) ? (
            <Button
              variant="quiet"
              size="xs"
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

          <Tooltip label={splitOpen ? "Close the split" : "Compare with another Agent Session"}>
            <Button variant="quiet" size="icon" aria-label="Toggle split" onClick={onToggleSplit}>
              <Columns2 size={11} aria-hidden />
            </Button>
          </Tooltip>

          <PaneOverflowMenu sessionId={sessionId} chrome={chrome} />

          {closable ? (
            <Tooltip label="Close this pane">
              <Button variant="quiet" size="icon" aria-label="Close this pane" onClick={onClose}>
                <X size={11} aria-hidden />
              </Button>
            </Tooltip>
          ) : null}
        </div>

        <div className="flex w-full items-center gap-2">
          <ScopeLabel scope={chrome.scope ?? ""} className="max-w-[28rem]" />
          <span className="truncate font-mono text-2xs text-(--color-fg-faint)">{sessionId}</span>
        </div>
      </div>

      {/* Directly under the header, spanning it: the one animation in the app. */}
      <RunningHairline running={chrome.status === "running"} />
    </div>
  );
}

function SteeringQueueBadge({ depth }: { depth: number }) {
  return (
    <Tooltip label="Messages the Session Host has accepted and will send after the current turn">
      <Badge tone="warn">{depth} queued</Badge>
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
      <span className="font-mono text-2xs text-(--color-fg-muted)">{label}</span>
      {fraction === undefined ? null : (
        <span className="inline-block h-1 w-12 overflow-hidden rounded-sm bg-(--color-inset)" aria-hidden>
          <span
            className="block h-full"
            style={{
              width: `${Math.round(fraction * 100)}%`,
              // Colour is spent only on encoding state: the meter goes warn as the window fills.
              backgroundColor:
                fraction > 0.9 ? "var(--color-err)" : fraction > 0.7 ? "var(--color-warn)" : "var(--color-accent)",
            }}
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
            <Button variant="quiet" size="icon" aria-label="More actions">
              <MoreHorizontal size={12} aria-hidden />
            </Button>
          }
        />
        <DropdownMenuPopup>
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
              <DropdownMenuItem
                className="text-(--color-err)"
                onClick={() => setConfirmEnd(true)}
              >
                End Agent Session…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuPopup>
      </DropdownMenu>

      <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <AlertDialogPopup>
          {/*
           * The app's only confirm. The copy avoids "close", "archive", "done" and "finished" — all
           * banned as synonyms for Settled — and it does not say "Settle", because this is the other
           * thing. It also does not imply the Agent Session disappears: an Ended one is never Reaped,
           * so it stays on disk and stays readable until somebody removes it by hand.
           */}
          <AlertDialogTitle>End Agent Session</AlertDialogTitle>
          <AlertDialogDescription>
            No Backend Session will run and this one will refuse a Revive. Its Presentation Transcript
            stays readable and stays on disk.
          </AlertDialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialogClose render={<Button variant="outline" size="sm">Keep it</Button>} />
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmEnd(false);
                void run({ type: "dispose", sessionId });
              }}
            >
              End Agent Session
            </Button>
          </div>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
