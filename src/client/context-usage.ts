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
 * Rows rather than one string because the two readings are not the same measure and must not read as
 * one sentence: Context is how full the window is, Spent is every token billed across every model,
 * Subagents included. Spent is routinely the larger number and says nothing about running out of
 * room — printing them adjacent without labels invited exactly that confusion.
 *
 * Returns undefined with no window, matching `contextUsageLabel`'s "nothing honest to say".
 */
export type UsageRow = { label: string; value: string; /** A per-model line, for indenting. */ model?: true };

export function contextUsageDetail(usage: ViewState["contextUsage"]): UsageRow[] | undefined {
  if (!usage || usage.window <= 0) return undefined;
  const { used, window, spend } = usage;
  const rows: UsageRow[] = [
    {
      label: "Context",
      value: `${Math.round((used / window) * 100)}% · ${compactTokens(used)}/${compactTokens(window)} tokens`,
    },
  ];
  // Absent whenever the backend cannot report it, rather than shown as a zero that reads as "free".
  if (!spend) return rows;

  rows.push({ label: "Spent", value: `${compactTokens(spend.tokens)} tokens · ${money(spend.costUSD)}` });
  // Stated as a share of the total, because the bare figure invites reading it as extra spend on top
  // rather than as the majority of what is already counted above.
  rows.push({ label: "Cache reads", value: `${compactTokens(spend.cached)} of ${compactTokens(spend.tokens)}` });

  // One model is what `Spent` already says, so the breakdown earns its space only when it splits.
  // Two or more means a Subagent ran on its own model, which is the case worth seeing.
  if (spend.models.length > 1) {
    for (const model of spend.models) {
      rows.push({ label: model.id, value: `${compactTokens(model.tokens)} · ${money(model.costUSD)}`, model: true });
    }
  }
  return rows;
}

/**
 * Enough places to stay honest at both ends: a Subagent on a cheap model can cost a tenth of a
 * cent, and rounding that to `$0.00` would report free work. Anything at or above a cent reads in
 * the two places money is normally written.
 */
function money(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd === 0) return "$0.00";
  return `$${usd.toFixed(4)}`;
}

/**
 * Hand-rolled rather than `Intl`, to match `relativeTime` and to read the same in a terminal.
 *
 * Exported for `reduce.ts`, which writes the same token counts into a compaction marker's label. The
 * import goes that way and not this one at runtime: this module takes only `ViewState`, as a type,
 * so there is no cycle to worry about.
 */
export function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return `${count}`;
}
