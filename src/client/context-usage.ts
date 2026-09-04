import type { ViewState } from "./reduce.ts";

/**
 * How much of the Conversation Context is spent, as one short chrome label.
 *
 * The two front-ends had drifted on the wording — the TUI said `context 12%` and the web UI said
 * `12% context` for the same numbers. The TUI's wording wins because it reads as a label rather than
 * as a sentence fragment, and because it is the one with tests.
 */
export function contextUsageLabel(usage: ViewState["contextUsage"]): string | undefined {
  if (!usage) return undefined;
  const { used, window } = usage;
  // A window of zero means the backend reports spend but not a budget, so a percentage would lie.
  return window > 0 ? `context ${Math.round((used / window) * 100)}%` : `${used} tokens`;
}

/**
 * The same reading spelled out in full, for a hover where there is room for the numbers.
 *
 * Here rather than in `web/src/presentation/` so the rounding rule lives in one place: the TUI
 * prints `contextUsageLabel`'s percentage, and the same `used / window` stated twice is the drift
 * this file exists to prevent.
 *
 * Returns undefined with no window, matching `contextUsageLabel`'s "nothing honest to say".
 */
export function contextUsageDetail(usage: ViewState["contextUsage"]): string | undefined {
  if (!usage || usage.window <= 0) return undefined;
  const { used, window } = usage;
  return `${Math.round((used / window) * 100)}% · ${compactTokens(used)}/${compactTokens(window)} tokens`;
}

/** Hand-rolled rather than `Intl`, to match `relativeTime` and to read the same in a terminal. */
function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return `${count}`;
}
