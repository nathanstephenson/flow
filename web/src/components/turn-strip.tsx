import { GitBranch } from "lucide-react";
import { useState } from "react";

import { scopeKindHint, scopeKindLabel } from "@client/scope-kind.ts";
import { occupied } from "@client/status.ts";
import { useBranches } from "@/branches.ts";
import type { ComposerActions } from "@/composer-actions.ts";
import type { Chrome } from "@/store/contract.ts";
import { ContextUsageMeter } from "@/components/context-usage-meter.tsx";
import { EffortPicker, ModelPicker } from "@/components/model-picker.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { QUIET_TRIGGER } from "@/lib/quiet-trigger.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Everything that decides what the next turn does, on one line: which model runs it, how hard it
 * thinks, how much room is left, and where the edits land.
 *
 * All four belong to the composer rather than to the pane header on the rule `composer.tsx` states —
 * the header says what an Agent Session *is*, this says what the next turn will *do*. The branch is
 * the one that reads like identity until you notice what the control is for: the edits this message
 * causes happen in that directory, on that branch, which makes it a property of the message about to
 * be sent rather than of the session.
 *
 * **A grid, not a flex row with `ml-auto`.** The meter has to sit in the middle whether or not there
 * is a branch to its right, and auto margins centre it in the space that is left rather than in the
 * row — so a Scope that is not a repository would have slid it off-centre.
 *
 * The branch half is absent for a Scope that is not a repository; the rest of the row is not, which
 * is why this renders unconditionally. A Project need not be a repository at all (ADR 0011).
 */
export function TurnStrip({ chrome, actions }: { chrome: Chrome; actions: ComposerActions }) {
  const ended = chrome.status === "ended";

  return (
    /*
     * Tight on purpose: this is the panel's second band, so every pixel is one the reader pays on
     * every pane. `py-1` against `text-xs` leaves the row the height of its own text, and the
     * divider is dimmed below the default border so it separates without drawing a line across the
     * composer.
     */
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-border/40 px-2 py-1">
      <div className="flex min-w-0 items-center gap-0.5">
        <ModelPicker
          models={chrome.capabilities?.models}
          model={chrome.model}
          disabled={ended}
          // A reading in the strip, not a form field: see `ModelPickerProps.quiet`.
          quiet
          onSelect={actions.setModel}
        />
        <EffortPicker
          capabilities={chrome.capabilities}
          model={chrome.model}
          effort={chrome.effort}
          disabled={ended}
          onSelect={actions.setEffort}
        />
      </div>

      <ContextUsageMeter usage={chrome.contextUsage} compacting={chrome.compacting} />

      {/*
       * Pinned to the third track rather than auto-placed: the meter renders nothing at all until
       * the first token count arrives, and an absent element is not an empty column — auto-placement
       * would put the branch in the middle track and leave it centred.
       */}
      <div className="col-start-3 flex min-w-0 items-center justify-end">
        <BranchPicker chrome={chrome} actions={actions} />
      </div>
    </div>
  );
}

/**
 * Which branch the next turn's edits land on.
 *
 * The checkout it belongs to is named in the tooltip rather than beside it. It cannot be a control —
 * a Scope is fixed for an Agent Session's whole life, and a different directory is a different Agent
 * Session — so spending a label on it every time cost a reading that never changes. The cost of
 * moving it here is real and worth naming: **a Worktree is no longer distinguishable at a glance**,
 * only on hover and by its branch happening to be named `flow/…`.
 */
function BranchPicker({ chrome, actions }: { chrome: Chrome; actions: ComposerActions }) {
  const branches = useBranches(chrome.scope);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  if (!chrome.branch) return null;

  const branch = chrome.branch;
  // Matches the Session Host, which refuses a branch switch on `turnInFlight` — true while Awaiting.
  const running = occupied(chrome.status);
  const ended = chrome.status === "ended";

  return (
    <Tooltip>
      {/*
       * The tooltip wraps the Select rather than being its trigger, for two reasons: upstream's
       * Trigger hands its own props to whatever it renders, so the target has to be a real element
       * that forwards them; and this way the hint still appears while the control is disabled, which
       * is exactly when it has something to say.
       */}
      <TooltipTrigger render={<span className="flex min-w-0 items-center" />}>
        <Select
          value={branch.detached ? null : branch.name}
          /*
           * Disabled rather than hidden, which is the opposite of the Effort rule above. That rule
           * is about a capability this Agent Session does not have; here the capability exists and
           * the *moment* is wrong, and a control that vanishes mid-turn reads as something breaking.
           * The host refuses this anyway with a 409; saying so first beats being told no.
           */
          disabled={running || ended}
          onOpenChange={(open) => {
            if (open) branches.load();
          }}
          onValueChange={(value) => {
            if (typeof value !== "string" || value === branch.name) return;
            setFailure(undefined);
            void (async () => {
              if (!(await actions.switchBranch(value))) setFailure(`could not switch to ${value}`);
            })();
          }}
        >
          {/*
           * `min-w-0` on both the trigger and the value, or neither clips: the base trigger is
           * `w-fit whitespace-nowrap`, so a worktree branch — a prefix, a ticket, a description and
           * a date — sets its own width and spills out of the grid track and past the panel edge.
           * The whole name is still one hover away in the tooltip.
           */}
          <SelectTrigger aria-label="Branch" className={cn(QUIET_TRIGGER, "min-w-0 font-mono")}>
            <GitBranch aria-hidden className="size-3.5 shrink-0" />
            <SelectValue className="min-w-0">
              {() => <span className="truncate">{branch.name}</span>}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/*
             * Denser than the stock row, which is sized for prose: a branch is a single-line
             * identifier, so `min-h-6 py-0.5` fits one comfortably and a long list stays scannable
             * instead of becoming a scroll. There is no more compact primitive to reach for —
             * `DropdownMenu`'s rows carry the same `min-h-7 py-1.5` — so the size is set here, at
             * the one call site that wants it.
             */}
            {(branches.list?.branches ?? []).map((name) => (
              <SelectItem key={name} value={name} className="min-h-6 py-0.5 font-mono text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-0.5">
          <span>
            {failure ??
              (branch.detached
                ? `Detached at ${branch.name}`
                : running
                  ? "Finish or abort the turn to switch branch"
                  : `${scopeKindLabel(chrome)} · ${branch.name}`)}
          </span>
          {/* The only place the checkout is explained, now that it has no label of its own. */}
          <span className="text-muted-foreground">{scopeKindHint(chrome)}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
