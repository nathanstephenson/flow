import { contextUsageLabel } from "@client/context-usage.ts";
import type { Chrome } from "@/store/contract.ts";
import { cn } from "@/lib/utils.ts";

/**
 * How much of the Conversation Context is spent.
 *
 * Beside the composer rather than in the header, because it is a fact about what the *next turn* has
 * room to do — the same reason the model and Effort controls sit there. The wording comes from the
 * shared label so the TUI and this UI cannot drift on it again: they said `context 12%` and
 * `12% context` for the same numbers.
 */
export function ContextUsageMeter({ usage }: { usage: Chrome["contextUsage"] }) {
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
