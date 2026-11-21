import type { PullRequestSummary } from "../../../src/protocol/git.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { pullRequestBadges, type PullRequestBadge as BadgeValue, type PullRequestTone } from "@/presentation/git.ts";
import { cn } from "@/lib/utils.ts";

const tones: Record<PullRequestTone, string> = {
  muted: "text-muted-foreground",
  positive: "border-diff-added/40 text-diff-added",
  negative: "border-destructive/40 text-destructive",
  pending: "border-status-active/40 text-status-active",
  merged: "border-status-awaiting/40 text-status-awaiting",
};

export function PullRequestBadge({ badge }: { badge: BadgeValue }) {
  return <Badge variant="outline" className={cn("h-4 px-1.5", tones[badge.tone])}>{badge.label}</Badge>;
}

export function PullRequestBadges({ pr }: { pr: PullRequestSummary }) {
  const { state, checks } = pullRequestBadges(pr);
  return <><PullRequestBadge badge={state} />{checks ? <PullRequestBadge badge={checks} /> : null}</>;
}
