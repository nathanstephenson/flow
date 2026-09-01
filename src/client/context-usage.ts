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
