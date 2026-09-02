import type { SessionSummary } from "../protocol/commands.ts";

/**
 * What to call an Agent Session on screen. The title is derived from the first message
 * (`host.ts` `firstLine`), so an Agent Session nobody has written to yet has an empty one — and an
 * empty string renders as nothing at all rather than as something you can click.
 */
export function sessionLabel(summary: Pick<SessionSummary, "id" | "title">): string {
  return summary.title || summary.id;
}
