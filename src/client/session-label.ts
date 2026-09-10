import type { SessionSummary } from "../protocol/commands.ts";

/**
 * What to call an Agent Session on screen. The title is always derived, never authored: the first
 * line of the first message (`host.ts` `firstLine`), replaced seconds later by the Summary Model's
 * name where one is configured (ADR 0020). So an Agent Session nobody has written to yet has an
 * empty one — and an empty string renders as nothing at all rather than as something you can click.
 */
export function sessionLabel(summary: Pick<SessionSummary, "id" | "title">): string {
  return summary.title || summary.id;
}
