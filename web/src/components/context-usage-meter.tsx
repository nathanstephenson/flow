import { contextUsageDetail, contextUsageLabel } from "@client/context-usage.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import type { Chrome } from "@/store/contract.ts";
import { cn } from "@/lib/utils.ts";

/**
 * How much of the Conversation Context is spent.
 *
 * Beside the composer rather than in the header, because it is a fact about what the *next turn* has
 * room to do — the same reason the model and Effort controls sit there. The bar alone carries it at
 * rest; the numbers are one hover away, from the shared formatter so the TUI and this UI cannot
 * drift on the rounding again.
 */
export function ContextUsageMeter({ usage, compacting }: { usage: Chrome["contextUsage"]; compacting: boolean }) {
  // Keyed off the formatter's "nothing honest to say" rather than re-testing the window here, so
  // there is one place that decides. No denominator means a bar would assert "nothing used yet",
  // and with the percentage text gone there is no honest text-only fallback left to show instead.
  const detail = contextUsageDetail(usage);
  /*
   * Except while compacting, when the word is shown on its own.
   *
   * A Revived session has no `context_usage` until its backend reports one, and compacting is
   * exactly what someone does to a session they have just come back to — so the one moment the
   * indicator was most needed was the one moment this returned null and there was nothing to pulse.
   */
  if (!usage || detail === undefined) return compacting ? <Compacting /> : null;
  const fraction = Math.min(1, usage.used / usage.window);

  return (
    <Tooltip>
      {/* The trigger hands its props to whatever it renders, so the target must be a real element. */}
      <TooltipTrigger render={<span className="flex items-center" />}>
        {/*
         * Two steps, not three. The middle one was `--chart-4`, which rhea renders as a grey the
         * eye cannot separate from `--primary` on a 6px bar — so it encoded nothing. The bar's
         * *length* carries the value; the only thing worth a colour is a window about to overflow,
         * which is a real failure ahead and gets `--destructive`.
         * The width has to stay an inline style: it is a runtime percentage, not a class.
         */}
        <span className="inline-block h-1.5 w-32 overflow-hidden rounded-full bg-muted" aria-hidden>
          {/*
           * A compaction pulses the bar it is about to move. Summarising is a model call away, so
           * without this someone who asked for one watches an unchanged number and asks again — and
           * the bar is where they are already looking, which no toast can claim.
           */}
          <span
            className={cn(
              "block h-full",
              compacting ? "animate-pulse bg-primary" : fraction > 0.9 ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: compacting ? "100%" : `${Math.round(fraction * 100)}%` }}
          />
        </span>
        {/* The bar is `aria-hidden` and its length was half of what said the value; the text that
            carried the other half is gone, so the reading survives here. */}
        <span className="sr-only">{compacting ? "Compacting…" : contextUsageLabel(usage)}</span>
        {/* Said in words as well as pulsed. A 6px bar changing rhythm is not an answer to "did my
            keystroke do anything", and for three minutes it was the only one on offer. */}
        {compacting ? <Compacting className="ml-2" /> : null}
      </TooltipTrigger>
      <TooltipContent>
        {/* A two-column grid so the values line up: Spent sits under Context, not beside it. */}
        <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
          {detail.map((row) => (
            <span key={row.label} className="contents">
              <span className={cn("text-muted-foreground", row.model && "pl-3 font-mono text-xs")}>{row.label}</span>
              <span className={cn("text-right tabular-nums", row.model && "text-xs")}>{row.value}</span>
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The word, in the strip's own voice — a reading rather than a control, like everything beside it.
 *
 * Rendered on its own when there is no meter to sit beside, which is the case for a session Revived
 * expressly to be compacted: its `context_usage` has not arrived yet.
 */
function Compacting({ className }: { className?: string }) {
  return <span className={cn("animate-pulse text-xs text-muted-foreground", className)}>Compacting…</span>;
}
