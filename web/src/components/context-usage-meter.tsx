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
export function ContextUsageMeter({ usage }: { usage: Chrome["contextUsage"] }) {
  // Keyed off the formatter's "nothing honest to say" rather than re-testing the window here, so
  // there is one place that decides. No denominator means a bar would assert "nothing used yet",
  // and with the percentage text gone there is no honest text-only fallback left to show instead.
  const detail = contextUsageDetail(usage);
  if (!usage || detail === undefined) return null;
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
          <span
            className={cn("block h-full", fraction > 0.9 ? "bg-destructive" : "bg-primary")}
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
        {/* The bar is `aria-hidden` and its length was half of what said the value; the text that
            carried the other half is gone, so the reading survives here. */}
        <span className="sr-only">{contextUsageLabel(usage)}</span>
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
