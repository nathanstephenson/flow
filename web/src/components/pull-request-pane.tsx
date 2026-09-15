import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MergeMethod, PullRequestActionInput, PullRequestComment, PullRequestDetails, PullRequestCommentInput, PullRequestThreadInput } from "../../../src/protocol/pull-request.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { PullRequestMarkdown } from "@/components/pull-request-markdown.tsx";
import { checkStatus, checksSummary, pullRequestKey, PullRequestLoader, readableStatus, safePullRequestUrl, type PullRequestLoadState } from "@/presentation/pull-request.ts";

function Link({ url, children }: { url: string; children: ReactNode }) {
  const href = safePullRequestUrl(url);
  return href ? <a className="underline underline-offset-2 break-words" href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
}

export function PullRequestPane({ sessionId, revision = 0, disabled = false, onAvailable, onChange }: { sessionId: string; revision?: number; disabled?: boolean; onAvailable?: (available: boolean) => void; onChange?: () => void }) {
  const { connection } = useHost();
  const loader = useRef<PullRequestLoader<PullRequestDetails | null> | null>(null);
  const [state, setState] = useState<PullRequestLoadState<PullRequestDetails | null>>({ value: undefined, busy: true, error: "", success: "" });
  useEffect(() => {
    setState({ value: undefined, busy: true, error: "", success: "" });
    const current = new PullRequestLoader(() => connection.command<PullRequestDetails | null>({ type: "pull_request", sessionId }), setState);
    loader.current = current;
    const refresh = () => { if (document.visibilityState === "visible") void current.refresh(); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { current.dispose(); loader.current = null; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [connection, sessionId]);

  useEffect(() => { void loader.current?.refresh(); }, [revision]);
  useEffect(() => { onAvailable?.(Boolean(state.value)); }, [state.value, onAvailable]);

  function change(action: "rebase" | "merge", input: PullRequestActionInput) {
    void loader.current?.write(() => connection.command<void>({ type: "change_pull_request", sessionId, action, input }), action === "merge" ? "Pull request merged." : "Branch rebased locally. Nothing was pushed.", () => { onChange?.(); }, value => Boolean(value && pullRequestKey(value) === pullRequestKey(input.pr)));
  }

  function comment(input: PullRequestCommentInput, confirmed: () => void) {
    if (!state.value || pullRequestKey(input.pr) !== pullRequestKey(state.value)) return;
    void loader.current?.write(() => connection.command<void>({ type: "comment_pull_request", sessionId, input }), "Comment posted.", confirmed, (value) => Boolean(value && pullRequestKey(value) === pullRequestKey(input.pr)));
  }
  function resolve(input: PullRequestThreadInput) {
    if (!state.value || pullRequestKey(input.pr) !== pullRequestKey(state.value)) return;
    void loader.current?.write(() => connection.command<void>({ type: "resolve_pull_request_thread", sessionId, input }), input.resolved ? "Thread resolved." : "Thread reopened.", () => {}, (value) => Boolean(value && pullRequestKey(value) === pullRequestKey(input.pr)));
  }
  return <section aria-label="Pull request" className="min-w-0 space-y-4">
    <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Pull request</h2><Button size="sm" variant="outline" disabled={state.busy} onClick={() => void loader.current?.refresh()} aria-label="Refresh pull request">{state.busy ? "Refreshing…" : "Refresh"}</Button></div>
    {state.error ? <p role="alert">{state.value ? "Showing the last loaded pull request. " : ""}{state.error}</p> : null}
    {state.success ? <p role="status">{state.success}</p> : null}
    {state.value ? <PullRequestActions key={`${pullRequestKey(state.value)}:${state.value.headRefOid}:${state.value.baseRefName}`} pr={state.value} busy={state.busy || disabled} change={change} /> : null}
    {state.value === undefined ? <p>{state.error ? "Pull request unavailable." : "Reading pull request…"}</p> : state.value === null ? <p>No pull request found for this branch.</p> : <PullRequestContent key={pullRequestKey(state.value)} pr={state.value} busy={state.busy || disabled} comment={comment} resolve={resolve} />}
  </section>;
}

export function PullRequestActions({ pr, busy, change }: { pr: PullRequestDetails; busy: boolean; change: (action: "rebase" | "merge", input: PullRequestActionInput) => void }) {
  const [confirm, setConfirm] = useState<"rebase" | "merge">();
  const [method, setMethod] = useState<MergeMethod | "">("");
  if (pr.state !== "OPEN" || !pr.headRefOid) return null;
  const methods = pr.mergeMethods ?? [];
  return <section aria-label="Pull request actions" className="space-y-3">
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={busy || !!confirm} onClick={() => setConfirm("rebase")}>Rebase</Button>
      <Button size="sm" disabled={busy || !!confirm || pr.isDraft || methods.length === 0} onClick={() => { setMethod(methods[0] ?? ""); setConfirm("merge"); }}>Merge</Button>
    </div>
    {confirm ? <form aria-label={confirm === "merge" ? "Confirm merge" : "Confirm rebase"} className="space-y-3 rounded border p-3" onSubmit={event => {
      event.preventDefault();
      if (busy || (confirm === "merge" && !methods.includes(method as MergeMethod))) return;
      change(confirm, { pr: { repo: pr.repo, id: pr.id, number: pr.number }, headOid: pr.headRefOid!, baseBranch: pr.baseRefName, ...(confirm === "merge" ? { method: method as MergeMethod } : {}) });
      setConfirm(undefined);
    }}>
      <p>{confirm === "merge" ? `Merge #${pr.number} into ${pr.baseRefName} on GitHub?` : `Rebase only ${pr.headRefName} locally onto the latest ${pr.baseRefName}. No push or stack rebase. Requires a clean Scope. Conflicts abort the rebase.`}</p>
      {confirm === "merge" ? <label className="block space-y-1">Merge method<select aria-label="Merge method" className="ml-2 rounded border bg-background p-1" value={method} disabled={busy} onChange={event => setMethod(event.target.value as MergeMethod)}>{methods.map(value => <option key={value} value={value}>{value === "MERGE" ? "Merge commit" : value === "SQUASH" ? "Squash and merge" : "Rebase and merge"}</option>)}</select></label> : null}
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</Button><Button type="submit" disabled={busy || (confirm === "merge" && !methods.includes(method as MergeMethod))}>Confirm {confirm}</Button></div>
    </form> : null}
  </section>;
}

function PullRequestContent({ pr, busy, comment, resolve }: {
  pr: PullRequestDetails;
  busy: boolean;
  comment: (input: PullRequestCommentInput, confirmed: () => void) => void;
  resolve: (input: PullRequestThreadInput) => void;
}) {
  const ref = { repo: pr.repo, number: pr.number, id: pr.id };
  const markdown = (body: string) => <PullRequestMarkdown body={body} repo={pr.headRepository ?? pr.repo} headRefName={pr.headRefName} />;
  const entry = (item: PullRequestComment) => <article key={item.id} className="min-w-0 space-y-2 rounded-md border p-3"><div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"><strong>{item.author || "Unknown author"}</strong><Link url={item.url}><time dateTime={item.createdAt}>{item.createdAt ? new Date(item.createdAt).toLocaleString() : "View on GitHub"}</time></Link></div>{markdown(item.body)}</article>;
  return <div className="min-w-0 space-y-6">
    <section aria-label="Overview" className="space-y-3">
      <h3 className="font-medium">Overview</h3>
      <h4 className="text-base font-semibold"><Link url={pr.url}>#{pr.number} {pr.title}</Link></h4>
      <p><span className="rounded border px-2 py-0.5">{pr.state === "OPEN" && pr.isDraft ? "Draft" : readableStatus(pr.state)}</span> <span className="text-muted-foreground">by {pr.author || "Unknown author"}</span></p>
      <p className="break-all font-mono text-xs">{pr.headRefName} → {pr.baseRefName}</p>
      {pr.body ? markdown(pr.body) : <p className="text-muted-foreground">No description.</p>}
    </section>
    <section aria-label="Checks" className="space-y-3">
      <h3 className="font-medium">Checks</h3><p>{checksSummary(pr.statusCheckRollup)}</p>
      <ul className="space-y-2">{pr.statusCheckRollup.map((check, index) => <li key={index} className="flex flex-wrap justify-between gap-x-3"><Link url={check.detailsUrl || check.targetUrl || ""}>{check.name || check.context || "Check"}</Link><span>{readableStatus(checkStatus(check))}</span></li>)}</ul>
      <p>Review: {pr.reviewDecision ? readableStatus(pr.reviewDecision) : "No review decision"}</p>
      <p>{pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY" ? "Merge conflicts must be resolved." : pr.mergeable === "MERGEABLE" ? "No merge conflicts." : "Merge conflicts: unknown."}</p>
      <p className="text-muted-foreground">Merge status: {readableStatus(pr.mergeStateStatus)}</p>
    </section>
    <section aria-label="Discussion" className="space-y-4">
      <h3 className="font-medium">Discussion</h3>
      <h4 className="font-medium">Comments</h4>
      {pr.comments.length ? pr.comments.map(entry) : <p className="text-muted-foreground">No comments.</p>}
      {pr.viewerCanComment ? <CommentForm label="Add comment" busy={busy} send={(body, confirmed) => comment({ pr: ref, body }, confirmed)} /> : <p className="text-muted-foreground">You cannot comment on this pull request.</p>}
      <h4 className="font-medium">Reviews</h4>
      {pr.reviews.length ? pr.reviews.map((review) => <div key={review.id} className="space-y-2"><p className="text-xs font-medium">{readableStatus(review.state)}</p>{entry(review)}</div>) : <p className="text-muted-foreground">No reviews submitted.</p>}
      <h4 className="font-medium">Inline review threads</h4>
      {pr.threads.length ? pr.threads.map((thread) => <section key={thread.id} aria-label={`Review thread: ${thread.path}${thread.line === null ? "" : ` line ${thread.line}`}`} className="min-w-0 space-y-3 rounded-md border p-3">
        <p className="break-all font-mono text-xs">{thread.path}{thread.line === null ? "" : `:${thread.line}`}</p>
        <p className="text-xs text-muted-foreground">{thread.isResolved ? "Resolved" : "Unresolved"}{thread.isOutdated ? " · Outdated" : ""}</p>
        {thread.diffHunk ? <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs" aria-label="Diff context"><code>{thread.diffHunk}</code></pre> : null}
        {thread.comments.map(entry)}
        {thread.viewerCanReply ? <CommentForm label={`Reply to thread in ${thread.path}${thread.line === null ? "" : ` line ${thread.line}`}`} busy={busy} send={(body, confirmed) => comment({ pr: ref, body, threadId: thread.id }, confirmed)} /> : null}
        {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve({ pr: ref, threadId: thread.id, resolved: !thread.isResolved })}>{thread.isResolved ? "Reopen thread" : "Resolve thread"}</Button> : null}
      </section>) : <p className="text-muted-foreground">No inline review threads.</p>}
      <Link url={pr.url}>Continue on GitHub</Link>
    </section>
  </div>;
}

function CommentForm({ label, busy, send }: { label: string; busy: boolean; send: (body: string, confirmed: () => void) => void }) {
  const [draft, setDraft] = useState("");
  return <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (!busy && draft.trim()) send(draft, () => setDraft("")); }}>
    <label className="block space-y-1"><span className="text-xs font-medium">{label}</span><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} required /></label>
    <Button type="submit" size="sm" disabled={busy || !draft.trim()}>Post comment</Button>
  </form>;
}
