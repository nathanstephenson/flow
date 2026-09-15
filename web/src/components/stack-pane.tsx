import { useEffect, useState } from "react";
import { Copy, Plus } from "lucide-react";
import type { StackAction, StackReview, StackStatus } from "../../../src/protocol/stack.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

export function StackPane({ sessionId, disabled = false, onChange, onAvailable, revision = 0 }: { sessionId: string; disabled?: boolean; onChange: () => void; onAvailable?: (available: boolean) => void; revision?: number }) {
  const { connection } = useHost();
  const [status, setStatus] = useState<StackStatus>();
  const [review, setReview] = useState<StackReview>();
  const [names, setNames] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const [syncFailed, setSyncFailed] = useState(false);
  async function refresh() {
    setStatus(await connection.command<StackStatus>({ type: "stack_status", sessionId }));
  }
  useEffect(() => {
    let cancelled = false;
    void connection.command<StackStatus>({ type: "stack_status", sessionId }).then(
      (value) => { if (!cancelled) setStatus(value); },
      (failure: unknown) => { if (!cancelled) setError(String(failure)); },
    );
    return () => { cancelled = true; };
  }, [connection, sessionId, revision]);
  useEffect(() => { onAvailable?.(Boolean(status?.available && (status.view || status.candidate || status.rebasing))); }, [status, onAvailable]);
  async function run(action?: StackAction, branches?: string[], token?: string) {
    setBusy(true);
    setError("");
    setOutput("");
    try {
      if (!action) await refresh();
      else if ((action === "submit" || action === "sync") && !token) {
        setReview(await connection.command<StackReview>({ type: "prepare_stack", sessionId, action }));
      } else {
        setReview(undefined);
        setOutput(await connection.command<string>({ type: "change_stack", sessionId, input: { action, branches, token, ...(action === "init" ? { fingerprint: status?.candidate?.fingerprint } : {}) } }));
        if (action === "sync") setSyncFailed(false);
        if (action === "add") { setAdding(false); setNames(""); }
        onChange();
        await refresh();
      }
    } catch (failure) {
      setReview(undefined);
      setError(String(failure));
      if (action === "sync" && token) setSyncFailed(true);
      if (action) {
        onChange();
        try { await refresh(); } catch { setStatus(undefined); }
      }
    } finally { setBusy(false); }
  }
  async function assist() {
    setBusy(true);
    setError("");
    try {
      await connection.command({ type: "assist_stack", sessionId });
      setOutput("Asked this Agent Session to resolve conflicts and continue locally. Review its result, then refresh. No push, Publish, Sync, or merge was authorised.");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  const pullRequests = (status?.view ? status.view.branches.flatMap(branch => branch.pr ? [branch.pr] : []) : status?.candidate?.pullRequests ?? []).slice().reverse();
  async function copyLinks(prs = pullRequests, label = "Stack") {
    setError("");
    setOutput("");
    try {
      const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
      const html = prs.map(pr => `<div><a href="${escape(pr.url!)}">${escape(pr.title!)}</a></div>`).join("");
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([prs.map(pr => pr.title).join("\n")], { type: "text/plain" }),
      })]);
      setOutput(`${label} copied.`);
    } catch (failure) { setError(`Could not copy ${label === "Stack" ? "stack" : label}: ${String(failure)}`); }
  }
  const blocked = busy || disabled;
  if (!error && !output && !busy && !review && !syncFailed && (!status || (status.available && !status.view && !status.candidate && !status.rebasing && !status.problem))) return null;
  return <section aria-label="Stack" className="space-y-3">
    <div className="flex items-center gap-2"><h2 className="font-medium">Stack</h2><Button size="sm" variant="outline" disabled={blocked || !!review} onClick={() => void run()}>Refresh stack</Button>{pullRequests.length > 0 ? <Button size="icon-sm" variant="outline" aria-label="Copy stack" title="Copy stack" disabled={busy || pullRequests.some(pr => !pr.title || !pr.url)} onClick={() => void copyLinks()}><Copy aria-hidden="true" /></Button> : null}</div>
    {status?.problem ? <p role="status">{status.problem}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {output ? <pre role="status" className="whitespace-pre-wrap text-xs">{output}</pre> : null}
    {status?.available ? <>
      {status.view ? <p className="text-muted-foreground">Switching requires a clean Scope with no working Agent Sessions, Subagents, or Background Calls. Changes are never stashed. Use Publish for uncommitted files.</p> : null}
      {status.view ? <><p>Trunk: {status.view.trunk}</p><ul className="space-y-2">{status.view.branches.map((branch) => <li key={branch.name} className="flex flex-wrap items-center gap-2">
        <span>{branch.name}{branch.isCurrent ? " (current)" : ""}{branch.pr ? ` · #${branch.pr.number} ${branch.isMerged ? "MERGED" : branch.pr.state}` : branch.isMerged ? " · MERGED" : " · no PR"}{branch.needsRebase ? " · needs rebase" : ""}</span>
        {branch.pr ? <Button size="icon-sm" variant="outline" aria-label={`Copy PR #${branch.pr.number} link`} title={`Copy PR #${branch.pr.number} link`} disabled={busy || !branch.pr.title || !branch.pr.url} onClick={() => void copyLinks([branch.pr!], `PR #${branch.pr!.number}`)}><Copy aria-hidden="true" /></Button> : null}
        <Button size="sm" variant="outline" disabled={blocked || !!review || status.rebasing || branch.isCurrent} onClick={() => void run("checkout", [branch.name])}>Switch</Button>
      </li>)}</ul></> : null}
      {!status.rebasing && !status.view && status.candidate ? <>
        <p>PR-linked branches above {status.candidate.trunk} (bottom to top):</p>
        <ol>{status.candidate.pullRequests.map(pr => <li key={pr.branch} className="flex flex-wrap items-center gap-2">{pr.branch} · #{pr.number} {pr.state}<Button size="icon-sm" variant="outline" aria-label={`Copy PR #${pr.number} link`} title={`Copy PR #${pr.number} link`} disabled={busy || !pr.title || !pr.url} onClick={() => void copyLinks([pr], `PR #${pr.number}`)}><Copy aria-hidden="true" /></Button></li>)}</ol>
        <p>Create stack registers these branches. It does not create branches.</p>
        <Button size="sm" variant="outline" disabled={blocked || !!review} onClick={() => void run("init", status.candidate!.branches)}>Create stack</Button>
      </> : null}
      {!status.rebasing && status.view ? <>
        {adding ? <form className="space-y-2" aria-label="New branch" onSubmit={(event) => { event.preventDefault(); if (!blocked && !review && names.trim()) void run("add", [names.trim()]); }}>
          <label className="block">New branch name<Input autoFocus required value={names} onChange={(event) => setNames(event.target.value)} disabled={blocked || !!review} /></label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={blocked || !!review || !names.trim()}>Add branch</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setAdding(false); setNames(""); }}>Cancel</Button>
          </div>
        </form> : null}
        <div className="flex flex-wrap gap-2">
          {!adding ? <Button size="icon-sm" variant="outline" aria-label="New branch" title="New branch" disabled={blocked || !!review} onClick={() => setAdding(true)}><Plus aria-hidden="true" /></Button> : null}
          <Button size="sm" variant="outline" disabled={blocked || !!review || !status.view} onClick={() => void run("rebase")}>Rebase</Button>
          <Button size="sm" disabled={blocked || !!review || !status.view} onClick={() => void run("submit")}>Submit stack</Button>
          <Button size="sm" variant="outline" disabled={blocked || !!review || !status.view} onClick={() => void run("sync")}>Sync stack</Button>
        </div>
      </> : status.rebasing ? <>
        <h3>Rebase in progress</h3>
        <ul aria-label="Conflict files">{status.conflicts.map((file) => <li key={file}>{file}</li>)}</ul>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={blocked || status.conflicts.length > 0} onClick={() => void run("continue")}>Continue</Button>
          <Button size="sm" variant="outline" disabled={blocked} onClick={() => void run("abort")}>Abort</Button>
          <Button size="sm" variant="outline" disabled={blocked} onClick={() => void assist()}>Ask agent to fix, then continue</Button>
        </div><p>Abort restores the branches to their state before Rebase.</p>
      </> : null}
      {syncFailed ? <p role="status">Sync was not confirmed. On conflicts, gh stack sync restores all branches. Use Rebase to resolve conflicts locally, then review and confirm Sync again. Flow will not retry or push automatically.</p> : null}
      {review ? <section aria-label="Confirm Stack operation" className="space-y-3 border p-3">
        <h3>Confirm {review.action === "submit" ? "Submit" : "Sync"}</h3>
        <p>{review.action === "submit" ? "Push stack branches and create or update PRs and their bases. New PRs are drafts with automatic titles. Existing draft states stay unchanged." : "Fetch, rebase, and push stack branches. This changes local and remote branches. Conflicts restore all branches; resolve them with Rebase before a separately confirmed retry."}</p>
        <ul>{review.view.branches.map((branch) => <li key={branch.name}>{branch.name} · {branch.pr ? `#${branch.pr.number} ${branch.pr.state}` : "new draft PR on Submit"}{branch.isMerged || branch.isQueued ? " (merged or queued; gh stack may skip)" : ""}</li>)}</ul>
        <Button variant="outline" disabled={blocked} onClick={() => setReview(undefined)}>Cancel</Button>{" "}
        <Button disabled={blocked} onClick={() => void run(review.action, undefined, review.token)}>Confirm and {review.action}</Button>
      </section> : null}
    </> : null}
  </section>;
}
