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

function Indicator({ indicator }: { indicator: PullRequestIndicator }) {
  return <><PullRequestIcon indicator={indicator} className="size-3!" /><span className="sr-only">{indicator.label}</span></>;
}

export function PullRequestIndicators({ pr }: { pr: PullRequestSummary }) {
  const { state, checks, text } = pullRequestIndicators(pr);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 items-center gap-0.5" />}>
        <Indicator indicator={state} />
        {checks ? <Indicator indicator={checks} /> : null}
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
