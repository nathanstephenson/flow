import { useEffect, useState } from "react";
import { Copy, Plus } from "lucide-react";
import type { StackAction, StackGraphBranch, StackPullRequest, StackReview, StackStatus } from "../../../src/protocol/stack.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

type GraphRow = { branch: StackGraphBranch; depth: number };

function graphRows(branches: StackGraphBranch[]): GraphRow[] {
  const names = new Set(branches.map(branch => branch.name));
  const children = new Map<string, StackGraphBranch[]>();
  for (const branch of branches) {
    if (!branch.parent || !names.has(branch.parent)) continue;
    const list = children.get(branch.parent) ?? [];
    list.push(branch);
    children.set(branch.parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const roots = branches.filter(branch => !branch.parent || !names.has(branch.parent)).sort((a, b) => a.name.localeCompare(b.name));
  const result: GraphRow[] = [];
  const append = (branch: StackGraphBranch, depth: number) => {
    result.push({ branch, depth });
    for (const child of children.get(branch.name) ?? []) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return result;
}

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
  const [requestGeneration] = useState({ current: 0 });
  function refresh(): Promise<void> {
    const generation = ++requestGeneration.current;
    setStatus(undefined);
    setReview(undefined);
    return connection.command<StackStatus>({ type: "stack_status", sessionId }).then(value => {
      if (generation === requestGeneration.current) setStatus(value);
    });
  }
  useEffect(() => {
    setAdding(false);
    setNames("");
    setSyncFailed(false);
    setError("");
    setOutput("");
    const generation = ++requestGeneration.current;
    void connection.command<StackStatus>({ type: "stack_status", sessionId }).then(
      value => { if (generation === requestGeneration.current) setStatus(value); },
      failure => { if (generation === requestGeneration.current) setError(String(failure)); },
    );
    return () => { requestGeneration.current++; };
  }, [connection, sessionId, revision]);
  const managedVisible = Boolean(status?.view && (!status.view.currentBranch || !status.view.trunk || status.view.currentBranch !== status.view.trunk));
  const diagnostic = Boolean(error || status?.warnings?.length || (status?.problem && status.problemKind !== "action"));
  const discovered = Boolean(status?.graph || managedVisible || status?.candidate || status?.rebasing);
  const visible = discovered || diagnostic || busy || Boolean(output || review || syncFailed);
  useEffect(() => { onAvailable?.(visible); }, [visible, onAvailable]);

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

  // Managed and candidate states remain useful when broad graph discovery is unavailable.
  const displayBranches = status?.graph?.branches.map(branch => ({ ...branch })) ?? [];
  const displayByName = new Map(displayBranches.map(branch => [branch.name, branch]));
  let displayParent = status?.view?.trunk ?? status?.candidate?.trunk;
  for (const member of status?.view?.branches ?? []) {
    const existing = displayByName.get(member.name);
    const branch: StackGraphBranch = existing ?? { name: member.name, parent: displayParent, relation: "local", isCurrent: member.isCurrent, availability: "local" };
    branch.pr = member.pr ? { ...member.pr, state: member.isMerged ? "MERGED" : member.pr.state } : branch.pr;
    branch.isCurrent = member.isCurrent;
    if (!existing) { displayBranches.push(branch); displayByName.set(branch.name, branch); }
    displayParent = member.name;
  }
  displayParent = status?.candidate?.trunk;
  for (const [index, member] of (status?.candidate?.pullRequests ?? []).entries()) {
    const name = member.branch ?? status?.candidate?.branches?.[index] ?? `pr-${member.number}`;
    const existing = displayByName.get(name);
    const branch: StackGraphBranch = existing ?? { name, parent: displayParent, relation: "pull-request", isCurrent: name === status?.graph?.currentBranch, availability: "local" };
    branch.pr = member;
    if (!existing) { displayBranches.push(branch); displayByName.set(branch.name, branch); }
    displayParent = name;
  }
  const pullRequests = displayBranches.flatMap(branch => branch.pr ? [branch.pr] : [])
    .filter((pr, index, all) => all.findIndex(other => other.number === pr.number) === index).reverse();
  async function copyLinks(prs: StackPullRequest[] = pullRequests, label = "Stack") {
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
  if (!visible) return null;
  const rows = graphRows(displayBranches);
  const managedByName = new Map(status?.view?.branches.map(branch => [branch.name, branch]) ?? []);
  return <section aria-label="Stack" className="space-y-3">
    <div className="flex items-center gap-2">
      <h2 className="font-medium">Stack</h2>
      <Button size="sm" variant="outline" disabled={blocked || !!review} onClick={() => void run()}>Refresh stack</Button>
      {pullRequests.length > 0 ? <Button size="icon-sm" variant="outline" aria-label="Copy stack" title="Copy stack" disabled={busy || pullRequests.some(pr => !pr.title || !pr.url)} onClick={() => void copyLinks()}><Copy aria-hidden="true" /></Button> : null}
    </div>
    {status?.problem && (status.problemKind !== "action" || discovered) ? <p role="status" className="text-muted-foreground">{status.problem}</p> : null}
    {status?.warnings?.length ? <ul aria-label="Stack diagnostics" className="space-y-1 text-muted-foreground">{status.warnings.map(warning => <li key={warning}>Warning: {warning}</li>)}</ul> : null}
    {error ? <p role="alert">{error}</p> : null}
    {output ? <pre role="status" className="whitespace-pre-wrap text-xs">{output}</pre> : null}

    {displayBranches.length ? <>
      <p>{status?.graph?.trunk ? <>Trunk: <span className="font-mono">{status.graph.trunk}</span></> : "Trunk unknown"}</p>
      <ul role="tree" aria-label="Stack branches" className="space-y-1 border-l border-border/70 py-1">
        {rows.map(({ branch, depth }) => {
          const managed = managedByName.get(branch.name);
          const pr = branch.pr ?? managed?.pr;
          return <li role="treeitem" aria-level={depth + 1} key={branch.name} className="flex flex-wrap items-center gap-2 py-1" style={{ paddingLeft: `${12 + depth * 20}px` }}>
            <span aria-hidden="true" className="text-muted-foreground">{depth ? "└" : "●"}</span>
            <span className={branch.isCurrent ? "font-medium" : undefined}>
              <span className="font-mono">{branch.name}</span>{branch.isCurrent ? " (current)" : ""}
              {branch.availability === "remote" ? " · remote-only" : " · local"}
              {pr ? ` · #${pr.number} ${pr.state}` : " · no PR"}
              {branch.relation === "ancestry" ? " · inferred" : ""}
            </span>
            {pr ? <Button size="icon-sm" variant="outline" aria-label={`Copy PR #${pr.number} link`} title={`Copy PR #${pr.number} link`} disabled={busy || !pr.title || !pr.url} onClick={() => void copyLinks([pr], `PR #${pr.number}`)}><Copy aria-hidden="true" /></Button> : null}
            {managed ? <Button size="sm" variant="outline" disabled={blocked || !!review || status?.rebasing || managed.isCurrent || branch.availability !== "local"} onClick={() => void run("checkout", [branch.name])}>Switch</Button> : null}
          </li>;
        })}
      </ul>
    </> : null}

    {status?.candidate ? <div aria-label="Branches to create" className="space-y-1">
      <p>Branches Create stack will register (bottom to top):</p>
      <ol>{status.candidate.pullRequests.map(pr => <li key={pr.branch}>{pr.branch} · #{pr.number} {pr.state}</li>)}</ol>
    </div> : null}
    {status?.graph && !status.view && !status.candidate ? <p className="text-muted-foreground">This is a read-only stack graph. Branching or remote-only graphs cannot be registered or changed from Flow.</p> : null}
    {!status?.rebasing && !status?.view && status?.candidate ? <>
      <p>Create stack registers only the branches listed above. It does not create or fetch branches.</p>
      {!status.available ? <p className="text-muted-foreground">Create stack is unavailable until gh-stack is installed on the Session Host.</p> : null}
      <Button size="sm" variant="outline" disabled={blocked || !!review || !status.available} onClick={() => void run("init", status.candidate!.branches)}>Create stack</Button>
    </> : null}

    {!status?.rebasing && managedVisible && status?.view ? <>
      <p className="text-muted-foreground">Switching requires a clean Scope with no working Agent Sessions, Subagents, or Background Calls. Changes are never stashed. Use Publish for uncommitted files.</p>
      {adding ? <form className="space-y-2" aria-label="New branch" onSubmit={(event) => { event.preventDefault(); if (!blocked && !review && names.trim()) void run("add", [names.trim()]); }}>
        <label className="block">New branch name<Input autoFocus required value={names} onChange={(event) => setNames(event.target.value)} disabled={blocked || !!review} /></label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={blocked || !!review || !names.trim()}>Add branch</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setAdding(false); setNames(""); }}>Cancel</Button>
        </div>
      </form> : null}
      <div className="flex flex-wrap gap-2">
        {!adding ? <Button size="icon-sm" variant="outline" aria-label="New branch" title="New branch" disabled={blocked || !!review} onClick={() => setAdding(true)}><Plus aria-hidden="true" /></Button> : null}
        <Button size="sm" variant="outline" disabled={blocked || !!review} onClick={() => void run("rebase")}>Rebase</Button>
        <Button size="sm" disabled={blocked || !!review} onClick={() => void run("submit")}>Submit stack</Button>
        <Button size="sm" variant="outline" disabled={blocked || !!review} onClick={() => void run("sync")}>Sync stack</Button>
      </div>
    </> : status?.rebasing ? <>
      <h3>Rebase in progress</h3>
      {!status.available ? <p className="text-muted-foreground">Install gh-stack on the Session Host before continuing or aborting this rebase.</p> : null}
      <ul aria-label="Conflict files">{status.conflicts.map(file => <li key={file}>{file}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={blocked || !status.available || status.conflicts.length > 0} onClick={() => void run("continue")}>Continue</Button>
        <Button size="sm" variant="outline" disabled={blocked || !status.available} onClick={() => void run("abort")}>Abort</Button>
        <Button size="sm" variant="outline" disabled={blocked || !status.available} onClick={() => void assist()}>Ask agent to fix, then continue</Button>
      </div><p>Abort restores the branches to their state before Rebase.</p>
    </> : null}
    {syncFailed ? <p role="status">Sync was not confirmed. On conflicts, gh stack sync restores all branches. Use Rebase to resolve conflicts locally, then review and confirm Sync again. Flow will not retry or push automatically.</p> : null}
    {review ? <section aria-label="Confirm Stack operation" className="space-y-3 border p-3">
      <h3>Confirm {review.action === "submit" ? "Submit" : "Sync"}</h3>
      <p>{review.action === "submit" ? "Push stack branches and create or update PRs and their bases. New PRs are drafts with automatic titles. Existing draft states stay unchanged." : "Fetch, rebase, and push stack branches. This changes local and remote branches. Conflicts restore all branches; resolve them with Rebase before a separately confirmed retry."}</p>
      <ul>{review.view.branches.map(branch => <li key={branch.name}>{branch.name} · {branch.pr ? `#${branch.pr.number} ${branch.pr.state}` : "new draft PR on Submit"}{branch.isMerged || branch.isQueued ? " (merged or queued; gh stack may skip)" : ""}</li>)}</ul>
      <Button variant="outline" disabled={blocked} onClick={() => setReview(undefined)}>Cancel</Button>{" "}
      <Button disabled={blocked} onClick={() => void run(review.action, undefined, review.token)}>Confirm and {review.action}</Button>
    </section> : null}
  </section>;
}
