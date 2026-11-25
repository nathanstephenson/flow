import { useEffect, useState } from "react";
import type { ChangesView, GitChanges as Changes, GitDiff, TourView } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { ChangedFiles } from "@/components/changed-files.tsx";
import { GitCommitForm } from "@/components/git-commit-form.tsx";
import { TourPane } from "@/components/tour-pane.tsx";
import { failureText, noChanges } from "@/presentation/git.ts";

type BranchView = "diff" | "tour";

const BRANCH_VIEW_KEY = "flow.git-branch-view";

type Props = {
  sessionId: string;
  revision: string;
  view: ChangesView;
  onViewChange: (view: ChangesView) => void;
  onCommitted: (commit: string) => void;
};

export function GitChanges({ sessionId, revision, view, onViewChange, onCommitted }: Props) {
  const { connection } = useHost();
  const [read, setRead] = useState<{ view: ChangesView; changes: Changes }>();
  const changes = read?.view === view ? read.changes : undefined;
  const [excluded, setExcluded] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [error, setError] = useState("");
  const [branchView, setBranchView] = useState<BranchView>("diff");

  useEffect(() => {
    if (readBranchView() !== "tour") return;
    let cancelled = false;
    void connection.command<TourView>({ type: "tour", sessionId }).then(
      (tour) => { if (!cancelled && tour.state !== "idle") setBranchView("tour"); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [connection, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void connection.command<Changes>({ type: "git_changes", sessionId, view }).then(
      (value) => {
        if (cancelled) return;
        const listed = (path: string) => value.files.some(file => file.path === path);
        setRead({ view, changes: value });
        setError("");
        if (view === "uncommitted") setExcluded(current => current.filter(listed));
      },
      (failure: unknown) => { if (!cancelled) setError(failureText(failure)); },
    );
    return () => { cancelled = true; };
  }, [connection, sessionId, view, revision]);

  return (
    <section aria-label="Changes" className="min-w-0 space-y-3">
      <Tabs
        value={view}
        onValueChange={(value: ChangesView) => {
          onViewChange(value);
          setError("");
        }}
      >
        <TabsList aria-label="Change views">
          <TabsTrigger value="uncommitted">Uncommitted</TabsTrigger>
          <TabsTrigger value="branch">Branch</TabsTrigger>
        </TabsList>
      </Tabs>
      {view === "branch" ? (
        <Tabs value={branchView} onValueChange={(value: BranchView) => { setBranchView(value); writeBranchView(value); }}>
          <TabsList aria-label="Branch views">
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="tour">Tour</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {view === "branch" && branchView === "tour" ? <TourPane key={sessionId} sessionId={sessionId} /> : error ? <p role="status" className="text-muted-foreground">{error}</p> : !changes ? <p>Reading changes…</p> : <>
        {changes.base ? <p className="text-xs text-muted-foreground">Changes since {changes.base}.</p> : null}
        {changes.commits.length > 0 ? <ul aria-label="Branch commits" className="space-y-0.5 font-mono text-xs">{changes.commits.map(commit => <li key={commit} className="truncate">{commit}</li>)}</ul> : null}
        {changes.files.length === 0 ? <p>{noChanges(view)}</p> : (
          <ChangedFiles
            files={changes.files}
            readDiff={(path) => connection.command<GitDiff>({ type: "git_diff", sessionId, view, path })}
            leading={view === "uncommitted" ? (file) => (
              <Checkbox
                aria-label={`Commit ${file.path}`}
                checked={!excluded.includes(file.path)}
                onCheckedChange={(checked: boolean) => setExcluded(current => checked ? current.filter(path => path !== file.path) : [...current, file.path])}
              />
            ) : undefined}
          />
        )}
        {view === "uncommitted" && changes.fingerprint && changes.files.length > 0 ? (
          <GitCommitForm
            sessionId={sessionId}
            paths={changes.files.map(file => file.path).filter(path => !excluded.includes(path))}
            fingerprint={changes.fingerprint}
            branch={changes.branch}
            defaultBranch={changes.defaultBranch}
            canRename={changes.canRename === true}
            message={message}
            branchName={branchName}
            onMessage={setMessage}
            onBranchName={setBranchName}
            onCommitted={(commit) => { setExcluded([]); onCommitted(commit); }}
          />
        ) : null}
      </>}
    </section>
  );
}

function readBranchView(): BranchView {
  try {
    return window.localStorage.getItem(BRANCH_VIEW_KEY) === "tour" ? "tour" : "diff";
  } catch {
    return "diff";
  }
}

function writeBranchView(view: BranchView): void {
  try {
    window.localStorage.setItem(BRANCH_VIEW_KEY, view);
  } catch {
    // The view still applies for this page's lifetime.
  }
}
