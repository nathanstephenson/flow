import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { railGroup } from "../../../src/client/status.ts";

export type RailSection = "needs-input" | "unread" | "pinned" | "working" | "idle" | "filed-away";
export type CollapsibleRailSection = "working" | "idle" | "filed-away";

export const RAIL_SECTIONS: readonly RailSection[] = ["needs-input", "unread", "pinned", "working", "idle", "filed-away"];

export function railSection(summary: SessionSummary, pinned: ReadonlySet<string> = new Set()): RailSection {
  const group = railGroup(summary);
  if (group === "needs-input" || group === "unread" || group === "filed-away") return group;
  if (pinned.has(summary.id)) return "pinned";
  return group === "dormant" ? "idle" : group;
}

export function collapsible(section: RailSection): section is CollapsibleRailSection {
  return section === "working" || section === "idle" || section === "filed-away";
}

export function visibleSessions(
  sessions: readonly SessionSummary[],
  open: ReadonlySet<CollapsibleRailSection>,
  pinned: ReadonlySet<string>,
): SessionSummary[] {
  const rank = (session: SessionSummary) => RAIL_SECTIONS.indexOf(railSection(session, pinned));
  return sessions
    .filter((session) => {
      const section = railSection(session, pinned);
      return !collapsible(section) || open.has(section);
    })
    .sort((a, b) => rank(a) - rank(b));
}

export function parsePinnedSessions(raw: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
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

export type HeldAttention = { id: string; attention: NonNullable<SessionSummary["attention"]> };

export function nextHeldAttention(
  current: HeldAttention | undefined,
  sessions: readonly SessionSummary[],
  focusedId: string | undefined,
): HeldAttention | undefined {
  const attention = sessions.find((session) => session.id === focusedId)?.attention;
  if (focusedId !== undefined && attention?.group === "unread") return { id: focusedId, attention };
  return current?.id === focusedId ? current : undefined;
}

export function withHeldAttention(
  sessions: SessionSummary[],
  held: HeldAttention | undefined,
): SessionSummary[] {
  if (!held) return sessions;
  return sessions.map((session) =>
    session.id === held.id && !session.attention ? { ...session, attention: held.attention } : session,
  );
}
