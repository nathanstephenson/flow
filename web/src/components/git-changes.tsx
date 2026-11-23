import { useEffect, useRef, useState } from "react";
import type { ChangesView, GitChanges as Changes, GitDiff, TourView } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { DiffText } from "@/components/diff-text.tsx";
import { GitCommitForm } from "@/components/git-commit-form.tsx";
import { TourPane } from "@/components/tour-pane.tsx";
import { diffHunks, diffNotice, failureText, noChanges } from "@/presentation/git.ts";

type BranchView = "diff" | "tour";

const BRANCH_VIEW_KEY = "flow.git-branch-view";

type Diffs = Record<string, GitDiff | { error: string }>;

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
  const [open, setOpen] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<Diffs>({});
  const [branchView, setBranchView] = useState<BranchView>("diff");
  const requests = useRef<Record<string, number>>({});

  function readDiff(path: string) {
    const key = `${view}\0${path}`;
    const request = (requests.current[key] ?? 0) + 1;
    requests.current[key] = request;
    const store = (value: Diffs[string]) => { if (requests.current[key] === request) setDiffs(current => ({ ...current, [key]: value })); };
    void connection.command<GitDiff>({ type: "git_diff", sessionId, view, path }).then(store, (failure: unknown) => store({ error: failureText(failure) }));
  }

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
        setOpen(current => current.filter(listed));
        for (const path of open.filter(listed)) readDiff(path);
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
          setOpen([]);
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
          <Accordion
            multiple
            value={open}
            onValueChange={(value: string[]) => {
              for (const path of value) if (!open.includes(path)) readDiff(path);
              setOpen(value);
            }}
          >
            {changes.files.map(file => (
              <AccordionItem key={file.path} value={file.path} className="border-b last:border-b-0">
                <div className="flex min-w-0 items-center gap-2">
                  {view === "uncommitted" ? (
                    <Checkbox
                      aria-label={`Commit ${file.path}`}
                      checked={!excluded.includes(file.path)}
                      onCheckedChange={(checked: boolean) => setExcluded(current => checked ? current.filter(path => path !== file.path) : [...current, file.path])}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <AccordionTrigger className="min-w-0 gap-3 rounded-none py-1.5 text-left font-mono text-xs font-normal">
                      <span className="w-5 shrink-0 whitespace-pre text-muted-foreground">{file.status}</span>
                      <span className="min-w-0 break-all">{file.path}</span>
                    </AccordionTrigger>
                  </div>
                </div>
                <AccordionContent className="pb-2">
                  <FileDiff path={file.path} diff={diffs[`${view}\0${file.path}`]} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
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

function FileDiff({ path, diff }: { path: string; diff: GitDiff | { error: string } | undefined }) {
  if (!diff) return <p className="text-xs text-muted-foreground">Reading diff…</p>;
  if ("error" in diff) return <p role="status" className="text-xs text-muted-foreground">{diff.error}</p>;
  const hunks = "text" in diff ? diffHunks(diff.text) : undefined;
  if (!hunks) return <p className="text-xs text-muted-foreground">{diffNotice(diff, path)}</p>;
  return (
    <pre className="m-0 max-h-[32rem] overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre text-foreground">
      <DiffText text={hunks} lang="diff" query="" />
    </pre>
  );
}
