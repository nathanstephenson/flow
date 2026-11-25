import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GitDiff, GitFile } from "../../../src/protocol/git.ts";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion.tsx";
import { DiffText } from "@/components/diff-text.tsx";
import { diffHunks, diffNotice, failureText } from "@/presentation/git.ts";

type Diffs = Record<string, GitDiff | { error: string }>;

type Props = {
  files: GitFile[];
  readDiff: (path: string) => Promise<GitDiff>;
  leading?: (file: GitFile) => ReactNode;
};

export function ChangedFiles({ files, readDiff, leading }: Props) {
  const [open, setOpen] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<Diffs>({});
  const requests = useRef<Record<string, number>>({});
  const seen = useRef(files);

  function read(path: string) {
    const request = (requests.current[path] ?? 0) + 1;
    requests.current[path] = request;
    const store = (value: Diffs[string]) => { if (requests.current[path] === request) setDiffs(current => ({ ...current, [path]: value })); };
    void readDiff(path).then(store, (failure: unknown) => store({ error: failureText(failure) }));
  }

  useEffect(() => {
    if (seen.current === files) return;
    seen.current = files;
    const listed = (path: string) => files.some(file => file.path === path);
    setOpen(current => current.filter(listed));
    for (const path of open.filter(listed)) read(path);
  }, [files]);

  return (
    <Accordion
      multiple
      value={open}
      onValueChange={(value: string[]) => {
        for (const path of value) if (!open.includes(path)) read(path);
        setOpen(value);
      }}
    >
      {files.map(file => (
        <AccordionItem key={file.path} value={file.path} className="border-b last:border-b-0">
          <div className="flex min-w-0 items-center gap-2">
            {leading?.(file)}
            <div className="min-w-0 flex-1">
              <AccordionTrigger className="min-w-0 gap-3 rounded-none py-1.5 text-left font-mono text-xs font-normal">
                <span className="w-5 shrink-0 whitespace-pre text-muted-foreground">{file.status}</span>
                <span className="min-w-0 break-all">{file.path}</span>
              </AccordionTrigger>
            </div>
          </div>
          <AccordionContent className="pb-2">
            <FileDiff path={file.path} diff={diffs[file.path]} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
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
