import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitChanges, GitDiff } from "../../../src/protocol/git.ts";
import type { PullRequestDetails, PullRequestListItem } from "../../../src/protocol/pull-request.ts";
import { useAgentSessions } from "@/agent-sessions.tsx";
import type { DraftStash } from "@/drafts.ts";
import { useHost } from "@/host.tsx";
import { appendToComposer, type AppendResult } from "@/components/composer.tsx";
import { ChangedFiles } from "@/components/changed-files.tsx";
import { ProjectPicker } from "@/components/new-agent-session-page.tsx";
import { PullRequestPane } from "@/components/pull-request-pane.tsx";
import { TourPane } from "@/components/tour-pane.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { failureText } from "@/presentation/git.ts";
import { groupProjects } from "@/presentation/projects.ts";
import { pullRequestNumber } from "@/presentation/pull-request.ts";

type Props = {
  project: string | undefined;
  pullRequest: number | undefined;
  drafts: DraftStash;
  onNavigate: (project?: string, pullRequest?: number) => void;
  onSession: (sessionId: string) => void;
};

export function PullRequestsPage({ project, pullRequest, drafts, onNavigate, onSession }: Props) {
  const { config } = useHost();
  const projects = config.projectList ?? [];
  return (
    <main className="@container/pull-requests min-h-0 overflow-y-auto p-4 pt-12 sm:p-8" aria-label="Pull Requests">
      <div className="mx-auto grid max-w-3xl grid-cols-1 gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="relative flex items-center gap-2">
            {project && pullRequest ? (
              <Tooltip>
                <TooltipTrigger render={<Button size="icon-sm" variant="ghost" className="@min-[57rem]/pull-requests:absolute @min-[57rem]/pull-requests:right-full @min-[57rem]/pull-requests:mr-2" onClick={() => onNavigate(project)} />}>
                  <ChevronLeft aria-hidden />
                  <span className="sr-only">All pull requests</span>
                </TooltipTrigger>
                <TooltipContent>All pull requests</TooltipContent>
              </Tooltip>
            ) : null}
            <h1 className="text-2xl font-semibold">Pull Requests</h1>
          </div>
          {projects.length > 0 ? (
            <ProjectPicker
              groups={groupProjects(projects)}
              projects={projects}
              project={projects.find((candidate) => candidate.path === project)}
              onPick={(picked) => onNavigate(picked.path)}
            />
          ) : null}
        </div>
        {projects.length === 0 ? (
          <p className="text-muted-foreground">No Projects yet. Add one under Settings → Projects.</p>
        ) : !project ? (
          <p className="text-muted-foreground">Choose a Project.</p>
        ) : pullRequest ? (
          <PullRequestDetail
            key={`${project}:${pullRequest}`}
            project={project}
            number={pullRequest}
            drafts={drafts}
            onSession={onSession}
          />
        ) : (
          <PullRequestList key={project} project={project} onOpen={(number) => onNavigate(project, number)} />
        )}
      </div>
    </main>
  );
}

function PullRequestList({ project, onOpen }: { project: string; onOpen: (number: number) => void }) {
  const { connection } = useHost();
  const [list, setList] = useState<PullRequestListItem[]>();
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const number = pullRequestNumber(text);

  useEffect(() => {
    let cancelled = false;
    void connection.command<PullRequestListItem[]>({ type: "project_pull_requests", project }).then(
      (value) => { if (!cancelled) setList(value); },
      (failure: unknown) => { if (!cancelled) setError(failureText(failure)); },
    );
    return () => { cancelled = true; };
  }, [connection, project]);

  return (
    <>
      <form aria-label="Open pull request" className="flex gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (number) onOpen(number);
      }}>
        <Input aria-label="Pull request number or URL" placeholder="Pull request number or URL" value={text} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={!number}>Open</Button>
      </form>
      {error ? <p role="alert">{error}</p> : !list ? <p>Reading pull requests…</p> : list.length === 0 ? (
        <p className="text-muted-foreground">No open pull requests.</p>
      ) : (
        <section aria-label="Open pull requests" className="grid gap-3">
          {list.map((item) => (
            <button key={item.id} className="rounded-lg border p-4 text-left hover:bg-muted focus-visible:outline-2" onClick={() => onOpen(item.number)}>
              <span className="flex flex-wrap items-center gap-2">
                <strong>#{item.number} {item.title}</strong>
                {item.isDraft ? <Badge variant="outline">Draft</Badge> : null}
                {item.reviewRequested ? <Badge variant="secondary">Review requested</Badge> : null}
              </span>
              <span className="block text-sm text-muted-foreground">by {item.author}</span>
            </button>
          ))}
        </section>
      )}
    </>
  );
}

function PullRequestDetail({ project, number, drafts, onSession }: {
  project: string;
  number: number;
  drafts: DraftStash;
  onSession: (sessionId: string) => void;
}) {
  const { connection } = useHost();
  const { sessions, nudge } = useAgentSessions();
  const [started, setStarted] = useState<{ sessionId: string; block?: string }>();
  const [pr, setPr] = useState<PullRequestDetails | null>();
  const [changes, setChanges] = useState<GitChanges>();
  const [changesError, setChangesError] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"diff" | "tour">("diff");
  const ref = pr ? { repo: pr.repo, number: pr.number, id: pr.id } : undefined;
  const fork = Boolean(pr && pr.headRepository?.toLowerCase() !== pr.repo.toLowerCase());

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    void connection.command<GitChanges>({ type: "pull_request_changes", project, pr: ref }).then(
      (value) => { if (!cancelled) { setChanges(value); setChangesError(""); } },
      (failure: unknown) => { if (!cancelled) setChangesError(failureText(failure)); },
    );
    return () => { cancelled = true; };
  }, [connection, project, pr?.id, pr?.headRefOid]);

  useEffect(() => {
    if (!started || !sessions.some((session) => session.id === started.sessionId)) return;
    if (started.block) appendToComposer(null, drafts, started.sessionId, started.block);
    onSession(started.sessionId);
  }, [sessions, started, drafts, onSession]);

  async function start(block?: string): Promise<AppendResult> {
    setStarting(true);
    try {
      const sessionId = await connection.command<string>({ type: "start_pull_request_session", project, pr: ref! });
      setStarted({ sessionId, ...(block ? { block } : {}) });
      nudge();
      return "added";
    } catch (failure) {
      setStarting(false);
      throw failure;
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!ref || fork || starting} onClick={() => {
          setError("");
          start().catch((failure: unknown) => setError(failureText(failure)));
        }}>Start Agent Session</Button>
      </div>
      {fork ? <p className="text-xs text-muted-foreground">This pull request comes from a fork. Flow can start an Agent Session only on a branch in the base repository.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <PullRequestPane target={{ project }} number={number} disabled={starting} onRead={setPr} onAddToDraft={fork ? undefined : start} />
      {ref ? (
        <section aria-label="Changed files" className="space-y-3">
          <h2 className="font-medium">Changed files</h2>
          <Tabs value={view} onValueChange={(value: "diff" | "tour") => setView(value)}>
            <TabsList aria-label="Change views">
              <TabsTrigger value="diff">Diff</TabsTrigger>
              <TabsTrigger value="tour">Tour</TabsTrigger>
            </TabsList>
          </Tabs>
          {view === "tour" ? <TourPane key={`${project}:${ref.number}`} target={{ project, pr: ref }} /> : changesError ? <p role="status" className="text-muted-foreground">{changesError}</p> : !changes ? <p>Reading changes…</p> : changes.files.length === 0 ? <p>No changed files.</p> : (
            <ChangedFiles files={changes.files} readDiff={(path) => connection.command<GitDiff>({ type: "pull_request_diff", project, pr: ref, path })} />
          )}
        </section>
      ) : null}
    </div>
  );
}
