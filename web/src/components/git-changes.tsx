import { useEffect, useState } from "react";
import type { ChangesView, GitChanges as Changes, GitDiff } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { DiffText } from "@/components/diff-text.tsx";
import { diffNotice, noChanges } from "@/presentation/git.ts";

type Diffs = Record<string, GitDiff | { error: string }>;

export function GitChanges({ sessionId, revision }: { sessionId: string; revision: string | undefined }) {
  const { connection } = useHost();
  const [view, setView] = useState<ChangesView>("uncommitted");
  const [changes, setChanges] = useState<Changes>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<Diffs>({});

  function readDiff(path: string) {
    const key = `${view}\0${path}`;
    void connection.command<GitDiff>({ type: "git_diff", sessionId, view, path }).then(
      (value) => setDiffs(current => ({ ...current, [key]: value })),
      (failure: unknown) => setDiffs(current => ({ ...current, [key]: { error: String(failure) } })),
    );
  }

  useEffect(() => {
    let cancelled = false;
    void connection.command<Changes>({ type: "git_changes", sessionId, view }).then(
      (value) => { if (!cancelled) { setChanges(value); setError(""); } },
      (failure: unknown) => { if (!cancelled) setError(String(failure)); },
    );
    for (const path of open) readDiff(path);
    return () => { cancelled = true; };
  }, [connection, sessionId, view, revision]);

  return (
    <section aria-label="Changes" className="min-w-0 space-y-3">
      <Tabs
        value={view}
        onValueChange={(value: ChangesView) => {
          setView(value);
          setOpen([]);
          setChanges(undefined);
          setError("");
        }}
      >
        <TabsList aria-label="Change views">
          <TabsTrigger value="uncommitted">Uncommitted</TabsTrigger>
          <TabsTrigger value="branch">Branch</TabsTrigger>
        </TabsList>
      </Tabs>
      {error ? <p role="status" className="text-muted-foreground">{error}</p> : !changes ? <p>Reading changes…</p> : <>
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
                <AccordionTrigger className="min-w-0 gap-3 rounded-none py-1.5 text-left font-mono text-xs font-normal">
                  <span className="w-5 shrink-0 whitespace-pre text-muted-foreground">{file.status}</span>
                  <span className="min-w-0 break-all">{file.path}</span>
                </AccordionTrigger>
                <AccordionContent className="pb-2">
                  <FileDiff diff={diffs[`${view}\0${file.path}`]} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </>}
    </section>
  );
}

function FileDiff({ diff }: { diff: GitDiff | { error: string } | undefined }) {
  if (!diff) return <p className="text-xs text-muted-foreground">Reading diff…</p>;
  if ("error" in diff) return <p role="status" className="text-xs text-muted-foreground">{diff.error}</p>;
  if ("text" in diff && diff.text) {
    return (
      <pre className="m-0 max-h-[32rem] overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre text-foreground">
        <DiffText text={diff.text} query="" />
      </pre>
    );
  }
  return <p className="text-xs text-muted-foreground">{diffNotice(diff)}</p>;
}
