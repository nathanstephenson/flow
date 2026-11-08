import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { railGroup } from "../../../src/client/status.ts";

export type RailSection = "needs-input" | "unread" | "working" | "idle" | "filed-away";
export type CollapsibleRailSection = "working" | "idle" | "filed-away";

export const RAIL_SECTIONS: readonly RailSection[] = ["needs-input", "unread", "working", "idle", "filed-away"];

export function railSection(summary: SessionSummary): RailSection {
  const group = railGroup(summary);
  return group === "dormant" ? "idle" : group;
}

export function collapsible(section: RailSection): section is CollapsibleRailSection {
  return section === "working" || section === "idle" || section === "filed-away";
}

export function visibleSessions(
  sessions: readonly SessionSummary[],
  open: CollapsibleRailSection | undefined,
): SessionSummary[] {
  return sessions.filter((session) => {
    const section = railSection(session);
    return !collapsible(section) || section === open;
  });
}

export function parseOpenSection(raw: string | null): CollapsibleRailSection | undefined {
  return raw !== null && collapsible(raw as RailSection) ? (raw as CollapsibleRailSection) : undefined;
}
