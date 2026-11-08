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
  open: ReadonlySet<CollapsibleRailSection>,
): SessionSummary[] {
  return sessions.filter((session) => {
    const section = railSection(session);
    return !collapsible(section) || open.has(section);
  });
}

export function parseOpenSections(raw: string | null): Set<CollapsibleRailSection> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((section): section is CollapsibleRailSection => collapsible(section)));
  } catch {
    return new Set();
  }
}
