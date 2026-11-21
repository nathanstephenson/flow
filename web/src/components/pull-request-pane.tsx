import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Command } from "../../../src/protocol/commands.ts";
import type { GitText, PullRequestSummary } from "../../../src/protocol/git.ts";
import type { MergeMethod, PullRequestActionInput, PullRequestCheck, PullRequestCheckLog, PullRequestRef, PullRequestComment, PullRequestCommentInput, PullRequestDetails, PullRequestEditInput, PullRequestReview } from "../../../src/protocol/pull-request.ts";
import { useHost } from "@/host.tsx";
import type { AppendResult } from "@/components/composer.tsx";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { PullRequestIcon } from "@/components/pull-request-indicators.tsx";
import { PullRequestMarkdown } from "@/components/pull-request-markdown.tsx";
import { pullRequestIndicators } from "@/presentation/git.ts";
import { checkDraftBlock, checksSummary, failedCheck, failedRuns, matchesSummary, orderedChecks, readableStatus, safePullRequestUrl, threadDraftBlock } from "@/presentation/pull-request.ts";

type Props = { sessionId: string; revision?: number; summary?: PullRequestSummary; disabled?: boolean; onAvailable?: (available: boolean) => void; onChange?: () => void; onAddToDraft: (block: string) => AppendResult };
type Confirm = { action: "merge" | "rebase"; input: PullRequestActionInput };

const notAdded: Record<Exclude<AppendResult, "added">, string> = {
  question: "Answer the question first. Then add to the Draft.",
  locked: "This Agent Session cannot take a message. Nothing was added.",
};

const methodLabels: Record<MergeMethod, string> = { MERGE: "Merge commit", SQUASH: "Squash and merge", REBASE: "Rebase and merge" };

function link(url: string, children: ReactNode) {
  const href = safePullRequestUrl(url);
  return href ? <a className="break-words underline underline-offset-2" href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
}

export function PullRequestPane({ sessionId, revision = 0, summary, disabled = false, onAvailable, onChange, onAddToDraft }: Props) {
  const { connection } = useHost();
  const [pr, setPr] = useState<PullRequestDetails | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; read: boolean }>();
  const [notice, setNotice] = useState("");
  const [sections, setSections] = useState(["overview", "checks", "threads", "discussion"]);
  const [openThreads, setOpenThreads] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm>();
  const [edit, setEdit] = useState<PullRequestEditInput>();
  const [added, setAdded] = useState<{ key: string; text: string }>();
  const readingLogs = useRef(new Set<string>());
  const latest = useRef(0);
  const summaryKey = JSON.stringify(summary ?? null);
  const seenSummary = useRef(summaryKey);
  const locked = busy || disabled;

  function read() {
    const request = ++latest.current;
    void connection.command<PullRequestDetails | null>({ type: "pull_request", sessionId }).then(
      (value) => {
        if (request !== latest.current) return;
        const shown = (input: { pr: PullRequestRef } | undefined) => Boolean(input && value && input.pr.id === value.id && input.pr.number === value.number && input.pr.repo === value.repo);
        setPr(value);
        setError(current => current?.read ? undefined : current);
        setConfirm(current => shown(current?.input) ? current : undefined);
        setEdit(current => shown(current) ? current : undefined);
        onAvailable?.(Boolean(value));
      },
      (failure: unknown) => {
        if (request === latest.current) setError({ text: `Pull request could not be read. ${String(failure)}`, read: true });
      },
    );
  }

  useEffect(() => {
    if (seenSummary.current === summaryKey) return;
    seenSummary.current = summaryKey;
    if (!pr || !matchesSummary(pr, summary)) read();
  }, [summaryKey]);

  useEffect(() => {
    read();
    const visible = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [connection, sessionId, revision]);

  async function write(command: Command, success: string, done?: () => void) {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await connection.command(command);
      done?.();
      setNotice(success);
      read();
    } catch (failure) { setError({ text: String(failure), read: false }); }
    finally { setBusy(false); }
  }

  async function suggest() {
    setBusy(true);
    setError(undefined);
    try {
      const text = await connection.command<GitText>({ type: "suggest_git_text", sessionId, kind: "pull_request" });
      setEdit(current => current && { ...current, ...(text.title ? { title: text.title } : {}), ...(text.body ? { body: text.body } : {}) });
    } catch (failure) { setError({ text: `No suggestion. ${String(failure)}`, read: false }); }
    finally { setBusy(false); }
  }

  function addToDraft(key: string, block: string, text = "Added to Draft.") {
    const result = onAddToDraft(block);
    setAdded({ key, text: result === "added" ? text : notAdded[result] });
  }

  async function addCheck(key: string, check: PullRequestCheck, pr: PullRequestRef) {
    if (check.jobId === undefined) return addToDraft(key, checkDraftBlock(check), "Added to Draft without a log. This check is not a GitHub Actions job.");
    if (readingLogs.current.has(key)) return;
    readingLogs.current.add(key);
    setAdded({ key, text: "Reading the job log…" });
    let log: PullRequestCheckLog | null;
    try { log = await connection.command<PullRequestCheckLog | null>({ type: "pull_request_check_log", sessionId, pr, jobId: check.jobId }); }
    catch (failure) { return setAdded({ key, text: String(failure) }); }
    finally { readingLogs.current.delete(key); }
    if (log) addToDraft(key, checkDraftBlock(check, log));
    else addToDraft(key, checkDraftBlock(check), "Added to Draft without a log. The job log could not be read or is too large.");
  }

  const addedStatus = (key: string, className = "") => <span role="status" className={`text-xs text-muted-foreground ${className}`}>{added?.key === key ? added.text : ""}</span>;

  function commentForm(key: string, label: string, input: Omit<PullRequestCommentInput, "body">) {
    const text = drafts[key] ?? "";
    return (
      <form aria-label={label} className="space-y-2" onSubmit={(event) => {
        event.preventDefault();
        if (!locked && text.trim()) void write({ type: "comment_pull_request", sessionId, input: { ...input, body: text } }, "Comment posted.", () => setDrafts(current => ({ ...current, [key]: "" })));
      }}>
        <label className="block space-y-1"><span className="text-xs font-medium">{label}</span><Textarea value={text} onChange={(event) => setDrafts(current => ({ ...current, [key]: event.target.value }))} disabled={locked} /></label>
        <Button type="submit" size="sm" disabled={locked || !text.trim()}>{input.threadId ? "Reply" : "Post comment"}</Button>
      </form>
    );
  }

  const body = () => {
    if (pr === undefined) return <p>{error ? "Pull request unavailable." : "Reading pull request…"}</p>;
    if (pr === null) return <p>No pull request found for this branch.</p>;
    const ref = { repo: pr.repo, number: pr.number, id: pr.id };
    const markdown = (text: string) => <PullRequestMarkdown body={text} repo={pr.headRepository ?? pr.repo} headRefName={pr.headRefName} />;
    const entry = (item: PullRequestComment | PullRequestReview) => (
      <article key={item.id} className="min-w-0 space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <strong>{item.author}</strong>
          {"state" in item ? <span>{readableStatus(item.state)}</span> : null}
          {link(item.url, <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>)}
        </div>
        {item.body ? markdown(item.body) : null}
      </article>
    );
    const threads = [...pr.threads].sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
    const discussion = [...pr.comments, ...pr.reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const { state } = pullRequestIndicators({ ...pr, checks: "none" });
    return (
      <Accordion aria-label="Pull request sections" multiple value={sections} onValueChange={setSections}>
        <AccordionItem value="overview" className="border-b">
          <AccordionTrigger>Overview</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <h3 className="text-base font-semibold">{link(pr.url, `#${pr.number} ${pr.title}`)}</h3>
            <p className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1"><PullRequestIcon indicator={state} className="size-3.5" />{state.label}</span>
              <span className="text-muted-foreground">by {pr.author}</span>
            </p>
            <p className="break-all font-mono text-xs">{pr.headRefName} → {pr.baseRefName}</p>
            <p className="text-xs text-muted-foreground">
              {pr.reviewDecision ? `Review: ${readableStatus(pr.reviewDecision)}` : "No review decision"} · {pr.mergeable === "CONFLICTING" ? "Merge conflicts must be resolved" : pr.mergeable === "MERGEABLE" ? "No merge conflicts" : "Merge conflicts unknown"}
            </p>
            {pr.body ? markdown(pr.body) : <p className="text-muted-foreground">No description.</p>}
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="checks" className="border-b">
          <AccordionTrigger>Checks ({pr.checks.length})</AccordionTrigger>
          <AccordionContent className="space-y-2">
            <p>{checksSummary(pr.checks)}</p>
            {failedRuns(pr.checks).map(run => (
              <div key={run.runId} className="flex min-w-0 flex-wrap items-center gap-2">
                <Button size="xs" variant="outline" disabled={locked} onClick={() => void write({ type: "rerun_pull_request_checks", sessionId, input: { pr: ref, runId: run.runId } }, "Re-run started.")}>Re-run failed jobs</Button>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{run.names.join(", ")}</span>
              </div>
            ))}
            <ul aria-label="Checks" className="space-y-1">
              {orderedChecks(pr.checks).map((check, index) => {
                const key = `check:${check.name}:${check.url}`;
                return (
                  <li key={index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    {link(check.url, check.name)}
                    <span className="flex items-center gap-2">
                      {failedCheck(check) ? <Button size="xs" variant="outline" disabled={readingLogs.current.has(key)} onClick={() => void addCheck(key, check, ref)}>Add to Draft</Button> : null}
                      <span>{readableStatus(check.status)}</span>
                    </span>
                    {addedStatus(key, "basis-full")}
                  </li>
                );
              })}
            </ul>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="threads" className="border-b">
          <AccordionTrigger>Review threads ({pr.threads.length})</AccordionTrigger>
          <AccordionContent>
            {threads.length ? (
              <Accordion
                aria-label="Review threads"
                multiple
                value={threads.filter(thread => openThreads[thread.id] ?? !thread.isResolved).map(thread => thread.id)}
                onValueChange={(value: string[]) => setOpenThreads(Object.fromEntries(threads.map(thread => [thread.id, value.includes(thread.id)])))}
              >
                {threads.map(thread => {
                  const place = `${thread.path}${thread.line === null ? "" : ` line ${thread.line}`}`;
                  return (
                    <AccordionItem key={thread.id} value={thread.id} className="border-b last:border-b-0">
                      <AccordionTrigger className="min-w-0 gap-3 py-1.5 text-left font-mono text-xs font-normal">
                        <span className="min-w-0 break-all">{place}</span>
                        <span className="shrink-0 font-sans text-muted-foreground">{thread.isResolved ? "Resolved" : "Unresolved"}{thread.isOutdated ? " · Outdated" : ""}</span>
                      </AccordionTrigger>
                      <AccordionContent className="space-y-3">
                        {thread.diffHunk ? <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs" aria-label="Diff context"><code>{thread.diffHunk}</code></pre> : null}
                        {thread.comments.map(entry)}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => addToDraft(`thread:${thread.id}`, threadDraftBlock(thread))}>Add to Draft</Button>
                          {addedStatus(`thread:${thread.id}`)}
                        </div>
                        {thread.viewerCanReply ? commentForm(`thread:${thread.id}`, `Reply to thread in ${place}`, { pr: ref, threadId: thread.id }) : null}
                        {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? (
                          <Button size="sm" variant="outline" disabled={locked} onClick={() => void write({ type: "resolve_pull_request_thread", sessionId, input: { pr: ref, threadId: thread.id, resolved: !thread.isResolved } }, thread.isResolved ? "Thread reopened." : "Thread resolved.")}>
                            {thread.isResolved ? "Reopen thread" : "Resolve thread"}
                          </Button>
                        ) : null}
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            ) : <p className="text-muted-foreground">No review threads.</p>}
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="discussion">
          <AccordionTrigger>Comments and reviews ({discussion.length})</AccordionTrigger>
          <AccordionContent className="space-y-3">
            {discussion.length ? discussion.map(entry) : <p className="text-muted-foreground">No comments or reviews.</p>}
            {pr.viewerCanComment ? commentForm(`comment:${pr.id}`, "Add comment", { pr: ref }) : <p className="text-muted-foreground">You cannot comment on this pull request.</p>}
            {link(pr.url, "Continue on GitHub")}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  };

  const open = pr?.state === "OPEN";
  const actionInput = pr ? { pr: { repo: pr.repo, number: pr.number, id: pr.id }, headOid: pr.headRefOid, baseBranch: pr.baseRefName } : undefined;
  return (
    <section aria-label="Pull request" className="min-w-0 space-y-3">
      {pr && open && actionInput ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={locked || !!confirm || pr.isDraft || pr.mergeMethods.length === 0} onClick={() => setConfirm({ action: "merge", input: { ...actionInput, method: pr.mergeMethods[0]! } })}>Merge</Button>
          <Button size="sm" variant="outline" disabled={locked || !!confirm} onClick={() => setConfirm({ action: "rebase", input: actionInput })}>Rebase</Button>
          <Button size="sm" variant="outline" disabled={locked || !!edit} onClick={() => setEdit({ pr: actionInput.pr, title: pr.title, body: pr.body })}>Edit</Button>
          <Button size="sm" variant="outline" disabled={locked} onClick={() => void write({ type: "set_pull_request_draft", sessionId, input: { pr: actionInput.pr, draft: !pr.isDraft } }, pr.isDraft ? "Marked ready for review." : "Converted to draft.")}>
            {pr.isDraft ? "Ready for review" : "Convert to draft"}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert">{error.read && pr ? "Showing the last pull request read. " : ""}{error.text}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {pr && confirm ? (
        <form aria-label={confirm.action === "merge" ? "Confirm merge" : "Confirm rebase"} className="space-y-3 rounded-md border p-3" onSubmit={(event) => {
          event.preventDefault();
          if (locked) return;
          setConfirm(undefined);
          void write({ type: "change_pull_request", sessionId, action: confirm.action, input: confirm.input }, confirm.action === "merge" ? "Pull request merged." : "Branch rebased locally. Nothing was pushed.", onChange);
        }}>
          <p>{confirm.action === "merge" ? `Merge #${pr.number} into ${confirm.input.baseBranch} on GitHub?` : `Rebase only ${pr.headRefName} locally onto the latest ${confirm.input.baseBranch}. No push or stack rebase. Requires a clean Scope. Conflicts abort the rebase.`}</p>
          {confirm.action === "merge" && confirm.input.method ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Merge method</span>
              <Select value={confirm.input.method} disabled={locked} onValueChange={(method: MergeMethod | null) => { if (method) setConfirm({ ...confirm, input: { ...confirm.input, method } }); }}>
                <SelectTrigger size="sm" aria-label="Merge method"><SelectValue>{methodLabels[confirm.input.method]}</SelectValue></SelectTrigger>
                <SelectContent>{pr.mergeMethods.map(method => <SelectItem key={method} value={method}>{methodLabels[method]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => setConfirm(undefined)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={locked}>{confirm.action === "merge" ? "Confirm merge" : "Confirm rebase"}</Button>
          </div>
        </form>
      ) : null}
      {pr && edit ? (
        <form aria-label="Edit pull request" className="space-y-3 rounded-md border p-3" onSubmit={(event) => {
          event.preventDefault();
          if (!locked && edit.title.trim()) void write({ type: "edit_pull_request", sessionId, input: edit }, "Pull request updated.", () => setEdit(undefined));
        }}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Edit pull request</h3>
            <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => void suggest()}>Suggest</Button>
          </div>
          <label className="block space-y-1">Title<Input required value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} disabled={locked} /></label>
          <label className="block space-y-1">Body<Textarea value={edit.body} onChange={(event) => setEdit({ ...edit, body: event.target.value })} disabled={locked} /></label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => setEdit(undefined)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={locked || !edit.title.trim()}>Save</Button>
          </div>
        </form>
      ) : null}
      {body()}
    </section>
  );
}
