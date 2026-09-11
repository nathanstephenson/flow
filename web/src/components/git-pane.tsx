import { useEffect, useState } from "react";
import type { GitFile, GitStatus, PublishReview, PublishResult } from "../../../src/protocol/publish.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export function GitPane({ sessionId }: { sessionId: string }) {
  const { connection } = useHost();
  const [status, setStatus] = useState<GitStatus>();
  const [review, setReview] = useState<PublishReview>();
  const [branch, setBranch] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PublishResult>();

  useEffect(() => {
    let cancelled = false;
    void connection.command<GitStatus>({ type: "git_status", sessionId }).then(
      (value) => { if (!cancelled) setStatus(value); },
      (failure: unknown) => { if (!cancelled) setError(String(failure)); },
    );
    return () => { cancelled = true; };
  }, [connection, sessionId]);

  async function refresh() {
    setBusy(true);
    setError("");
    try { setStatus(await connection.command<GitStatus>({ type: "git_status", sessionId })); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  async function openPublish() {
    setBusy(true);
    setOpening(true);
    setError("");
    setResult(undefined);
    try {
      setReview(await connection.command<PublishReview>({ type: "prepare_publish", sessionId }));
      setBranch("");
      setReady(false);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); setOpening(false); }
  }

  async function confirm() {
    if (!review) return;
    let confirmed = false;
    setBusy(true);
    setError("");
    try {
      const value = await connection.command<PublishResult>({ type: "publish", sessionId, input: {
        token: review.token, commitMessage: review.commitMessage, title: review.title, body: review.body, branch, ready,
      } });
      confirmed = true;
      setResult(value);
      setReview(undefined);
      setStatus(await connection.command<GitStatus>({ type: "git_status", sessionId }));
    } catch (failure) {
      setReview(undefined);
      setError(confirmed ? `Git status could not refresh. ${String(failure)}` : `Publish result is not confirmed. Refresh Git status before retrying. ${String(failure)}`);
    }
    finally { setBusy(false); }
  }

  return (
    <div className="min-h-0 space-y-4 overflow-auto p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{status?.branch ? `${status.branch.name}${status.branch.detached ? " (detached)" : ""}` : "Git"}</strong>
        <Button size="sm" variant="outline" disabled={busy || review !== undefined} onClick={() => void refresh()}>Refresh</Button>
        <Button size="sm" disabled={busy || review !== undefined || !status?.repository || Boolean(status.problem)} onClick={() => void openPublish()}>{busy ? "Please wait…" : "Publish"}</Button>
      </div>
      {!status ? <p>Reading Git status…</p> : !status.repository ? <p>This Scope is not a Git repository.</p> : <FileList files={status.files} />}
      {status?.problem ? <p role="status" className="text-muted-foreground">{status.problem}</p> : null}
      {status?.pr ? (
        <div className="space-y-2">
          <a className="underline" href={status.pr.url} target="_blank" rel="noreferrer">#{status.pr.number} {status.pr.title}</a>
          <p>{status.pr.isDraft ? "Draft" : "Ready for review"} · {status.pr.reviewDecision || "No review decision"}</p>
          <ul>{status.pr.statusCheckRollup.map((check, index) => <li key={index}>{check.name || check.context || "Check"}: {check.conclusion || check.state || check.status || "Unknown"}</li>)}</ul>
          {status.pr.statusCheckRollup.length === 0 ? <p>No checks reported.</p> : null}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {result ? <div role="status" className="space-y-2">
        {result.branch ? <p>Created branch {result.branch}.</p> : null}
        <p>{result.committed ? `Committed ${result.committed.slice(0, 8)}. ` : "No new commit confirmed. "}{result.pushed ? "Pushed." : "Push not confirmed."}</p>
        {result.url ? <a className="underline" href={result.url} target="_blank" rel="noreferrer">Open pull request</a> : null}
        {result.error ? <p>{result.error} Local Git changes, commits, and successful pushes are not undone. Refresh and open Publish to review before retrying.</p> : null}
      </div> : null}
      {opening || review !== undefined ? (
        <section aria-label="Confirm Publish" className="space-y-4 border-t pt-4">
          <h2 className="font-medium">Confirm Publish</h2>
          <p className="text-muted-foreground">Commit all listed changes, including staged and untracked files, then push. Git hooks will run.</p>
          {opening ? <p role="status">Reading changes and drafting publish text with the Summary Model…</p> : null}
          {review ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
            <h3 className="font-medium">Files to commit</h3>
            <FileList files={review.files} />
            {review.commits.length > 0 ? <div className="space-y-2"><h3 className="font-medium">Committed branch changes</h3><FileList files={review.committedFiles} /><ul className="max-h-32 overflow-auto text-xs">{review.commits.map((commit) => <li key={commit}>{commit}</li>)}</ul></div> : null}
            {review.warning ? <p role="status">{review.warning}</p> : null}
            {review.branch === review.defaultBranch ? <label className="block space-y-1">New feature branch<Input required value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy} /></label> : <p>Branch: {review.branch}</p>}
            <label className="block space-y-1">Commit message<Textarea required={review.files.length > 0} value={review.commitMessage} onChange={(event) => setReview({ ...review, commitMessage: event.target.value })} disabled={busy} /></label>
            {!review.pr ? <>
              <label className="block space-y-1">Pull request title<Input required value={review.title} onChange={(event) => setReview({ ...review, title: event.target.value })} disabled={busy} /></label>
              <label className="block space-y-1">Pull request body<Textarea value={review.body} onChange={(event) => setReview({ ...review, body: event.target.value })} disabled={busy} /></label>
            </> : null}
            {review.pr ? <p>Updates #{review.pr.number}. Its title, body, and draft state will not change.</p> : <label className="flex items-center gap-2"><input type="checkbox" checked={ready} onChange={(event) => setReady(event.target.checked)} disabled={busy} />Ready for review (otherwise draft)</label>}
            {error ? <p role="alert">{error}</p> : null}
            <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setReview(undefined)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Publishing…" : "Confirm and publish"}</Button></div>
          </form> : null}
        </section>
      ) : null}
    </div>
  );
}

function FileList({ files }: { files: GitFile[] }) {
  return files.length === 0 ? <p>No uncommitted changes. Publish pushes existing commits.</p> : <ul aria-label="Changed files" className="max-h-64 overflow-auto font-mono text-xs">{files.map((file) => <li className="break-all whitespace-pre-wrap" key={file.path}>{file.status} {file.path}</li>)}</ul>;
}
