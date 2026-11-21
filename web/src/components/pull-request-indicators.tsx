import { Check, Clock, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, X } from "lucide-react";
import type { PullRequestSummary } from "../../../src/protocol/git.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { pullRequestIndicators, type PullRequestIcon as Kind, type PullRequestIndicator, type PullRequestTone } from "@/presentation/git.ts";
import { cn } from "@/lib/utils.ts";

const icons: Record<Kind, typeof Check> = { draft: GitPullRequestDraft, open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed, passing: Check, failing: X, pending: Clock };
const tones: Record<PullRequestTone, string> = {
  muted: "text-muted-foreground",
  positive: "text-diff-added",
  negative: "text-destructive",
  pending: "text-status-active",
  merged: "text-status-awaiting",
};

export function PullRequestIcon({ indicator, className }: { indicator: PullRequestIndicator; className?: string }) {
  const Icon = icons[indicator.icon];
  return <Icon aria-hidden className={cn("shrink-0", tones[indicator.tone], className)} />;
}

export function PullRequestIndicators({ pr, className }: { pr: PullRequestSummary; className?: string }) {
  const { state, checks, text } = pullRequestIndicators(pr);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("flex shrink-0 items-center gap-0.5", className)} />}>
        <PullRequestIcon indicator={state} className="size-3!" />
        {checks ? <PullRequestIcon indicator={checks} className="size-3!" /> : null}
        <span className="sr-only">{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
