import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, X } from "lucide-react";
import type { StackCreate, StackInput, StackPullRequest, StackReview, StackStatus, StackView } from "../../../src/protocol/stack.ts";
import type { GitState } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { readableStatus, safePullRequestUrl } from "@/presentation/pull-request.ts";

type Form = { current: string; trunk?: string; branches: string[] };
type Branch = StackView["branches"][number];

function stateLine(branch: Branch): string {
  return [
    branch.pr ? `#${branch.pr.number} ${readableStatus(branch.isMerged ? "MERGED" : branch.pr.state)}` : branch.isMerged ? "Merged" : "No pull request",
    ...(branch.isQueued ? ["Queued"] : []),
    ...(branch.needsRebase ? ["Needs rebase"] : []),
    ...(branch.isCurrent ? ["Current"] : []),
  ].join(" · ");
}

function stackKey(view: StackView | undefined): string {
  return JSON.stringify(view && [view.trunk, view.currentBranch, view.branches.map(branch => [branch.name, branch.pr?.number, branch.pr?.state, branch.isMerged, branch.isQueued, branch.needsRebase])]);
}

function moved(list: string[], from: number, to: number): string[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function StackPane({ sessionId, git, refresh = 0, disabled = false, onChange, onAvailable }: { sessionId: string; git?: GitState | undefined; refresh?: number; disabled?: boolean; onChange: () => void; onAvailable?: (available: boolean) => void }) {
  const { connection } = useHost();
  const [status, setStatus] = useState<StackStatus>();
  const [available, setAvailable] = useState(false);
  const [readError, setReadError] = useState("");
  const [form, setForm] = useState<Form>();
  const [review, setReview] = useState<StackReview>();
  const [names, setNames] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const [syncFailed, setSyncFailed] = useState(false);
  const requestGeneration = useRef(0);
  const loadedBranch = useRef(git?.branch);
  const gitKey = JSON.stringify([git?.branch, git?.head, git?.pr?.number, git?.pr?.state]);

  function load(): Promise<void> {
    const generation = ++requestGeneration.current;
    if (loadedBranch.current !== git?.branch) {
      setStatus(undefined);
      setReview(undefined);
    }
    loadedBranch.current = git?.branch;
    return connection.command<StackStatus>({ type: "stack_status", sessionId }).then(value => {
      if (generation !== requestGeneration.current) return;
      setReadError("");
      setStatus(value);
      setReview(current => current && stackKey(current.view) === stackKey(value.view) ? current : undefined);
      setAvailable(value.available);
      setForm(current => value.create ? current?.current === value.create.current ? current : initialForm(value.create) : undefined);
    }, failure => { if (generation === requestGeneration.current) setReadError(String(failure)); });
  }
  useEffect(() => {
    void load();
    return () => { requestGeneration.current++; };
  }, [connection, sessionId, gitKey, refresh]);
  const visible = available || Boolean(readError);
  useEffect(() => { onAvailable?.(visible); }, [visible, onAvailable]);

  async function run(action: StackInput["action"], input: Omit<StackInput, "action"> = {}) {
    setBusy(true);
    setError("");
    setOutput("");
    try {
      if ((action === "submit" || action === "sync") && !input.token) {
        setReview(await connection.command<StackReview>({ type: "prepare_stack", sessionId, action }));
      } else {
        setReview(undefined);
        setOutput(await connection.command<string>({ type: "change_stack", sessionId, input: { action, ...input } }));
        if (action === "sync") setSyncFailed(false);
        if (action === "add") { setAdding(false); setNames(""); }
        onChange();
        await load();
      }
    } catch (failure) {
      setReview(undefined);
      setError(String(failure));
      if (action === "sync" && input.token) setSyncFailed(true);
      onChange();
      await load();
    } finally { setBusy(false); }
  }
  async function assist() {
    setBusy(true);
    setError("");
    try {
      await connection.command({ type: "assist_stack", sessionId });
      setOutput("Asked this Agent Session to resolve conflicts and continue locally. Review its result, then refresh. No push, Sync, or merge was authorised.");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  const branches = [...status?.view?.branches ?? []].reverse();
  const pullRequests = branches.flatMap(branch => branch.pr ? [branch.pr] : []);
  async function copyLinks(prs: StackPullRequest[] = pullRequests, label = "Stack") {
    setError("");
    setOutput("");
    try {
      const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
      const html = prs.map(pr => `<div><a href="${escape(pr.url!)}">${escape(pr.title ?? pr.url!)}</a></div>`).join("");
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([prs.map(pr => pr.title ?? pr.url).join("\n")], { type: "text/plain" }),
      })]);
      setOutput(`${label} copied.`);
    } catch (failure) { setError(`Could not copy ${label === "Stack" ? "stack" : label}: ${String(failure)}`); }
  }

  const blocked = busy || disabled;
  if (!visible) return null;
  const addable = status?.create && form ? status.create.unstacked.filter(name => name !== form.trunk && !form.branches.includes(name)) : [];
  return <section aria-label="Stack" className="space-y-3">
    <div className="flex items-center gap-2">
      <h2 className="font-medium">Stack</h2>
      {pullRequests.length > 0 ? <Button size="icon-sm" variant="outline" aria-label="Copy stack" title="Copy stack" disabled={busy || pullRequests.some(pr => !pr.url)} onClick={() => void copyLinks()}><Copy aria-hidden="true" /></Button> : null}
    </div>
    {error || readError ? <p role="alert">{error || readError}</p> : null}
    {output ? <pre role="status" className="whitespace-pre-wrap text-xs">{output}</pre> : null}
    {status?.notice ? <p className="text-muted-foreground">{status.notice}</p> : null}

    {status?.view ? <ol aria-label="Stack branches" className="space-y-1">
      {branches.map(branch => <li key={branch.name} className="flex min-w-0 items-center gap-2 py-1">
        <div className="min-w-0 flex-1">
          <p className={`truncate font-mono ${branch.isCurrent ? "font-semibold" : ""}`}>{branch.name}</p>
          {branch.pr?.title ? <p className="truncate">{branch.pr.title}</p> : null}
          <p className="text-xs text-muted-foreground">{branch.pr?.url ? <a className="underline" href={safePullRequestUrl(branch.pr.url)} target="_blank" rel="noreferrer">{stateLine(branch)}</a> : stateLine(branch)}</p>
        </div>
        {branch.pr ? <Button size="icon-sm" variant="outline" aria-label={`Copy PR #${branch.pr.number} link`} title={`Copy PR #${branch.pr.number} link`} disabled={busy || !branch.pr.url} onClick={() => void copyLinks([branch.pr!], `PR #${branch.pr!.number}`)}><Copy aria-hidden="true" /></Button> : null}
        <Button size="sm" variant="outline" disabled={blocked || !!review || status.rebasing || branch.isCurrent} onClick={() => void run("checkout", { branches: [branch.name] })}>Switch</Button>
      </li>)}
      <li className="py-1"><span className="font-mono text-muted-foreground">{status.view.trunk}</span> <span className="text-xs text-muted-foreground">Trunk</span></li>
    </ol> : null}

    {status?.create && form ? <section aria-label="Create stack" className="space-y-3">
      <p className="text-muted-foreground">This branch is not in a stack. Choose the branches from top to bottom, and the trunk.</p>
      <Select name="branch" value={null} disabled={blocked || !addable.length} onValueChange={(name: string | null) => { if (name) setForm({ ...form, branches: [...form.branches, name] }); }}>
        <SelectTrigger size="sm" aria-label="Add branch"><SelectValue>Add branch</SelectValue></SelectTrigger>
        <SelectContent>{addable.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
      </Select>
      <ol aria-label="Branches to register" className="space-y-1">
        {form.branches.map((name, index) => <li key={name} className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
          <Button size="icon-sm" variant="ghost" aria-label={`Move ${name} up`} title="Move up" disabled={blocked || index === form.branches.length - 1} onClick={() => setForm({ ...form, branches: moved(form.branches, index, index + 1) })}><ArrowUp aria-hidden="true" /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Move ${name} down`} title="Move down" disabled={blocked || index === 0} onClick={() => setForm({ ...form, branches: moved(form.branches, index, index - 1) })}><ArrowDown aria-hidden="true" /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${name}`} title="Remove" disabled={blocked} onClick={() => setForm({ ...form, branches: form.branches.filter(other => other !== name) })}><X aria-hidden="true" /></Button>
        </li>).reverse()}
      </ol>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">Trunk</span>
        <Select name="trunk" value={form.trunk ?? null} disabled={blocked} onValueChange={(trunk: string | null) => { if (trunk) setForm({ ...form, trunk, branches: form.branches.filter(name => name !== trunk) }); }}>
          <SelectTrigger size="sm" aria-label="Trunk"><SelectValue>{form.trunk ?? "Choose the trunk"}</SelectValue></SelectTrigger>
          <SelectContent>{status.create.branches.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground">Create stack registers these branches in this order, then switches to the top branch. It does not commit, rebase or push.</p>
      <Button size="sm" disabled={blocked || !form.trunk || !form.branches.length} onClick={() => void run("init", { branches: form.branches, ...(form.trunk ? { trunk: form.trunk } : {}) })}>Create stack</Button>
    </section> : null}

    {!status?.rebasing && status?.view ? <>
      <p className="text-muted-foreground">Switching requires a clean Scope with no working Agent Sessions, Subagents, or Background Calls. Changes are never stashed. Commit uncommitted files first.</p>
      {adding ? <form className="space-y-2" aria-label="New branch" onSubmit={(event) => { event.preventDefault(); if (!blocked && !review && names.trim()) void run("add", { branches: [names.trim()] }); }}>
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
      <ul aria-label="Conflict files">{status.conflicts.map(file => <li key={file}>{file}</li>)}</ul>
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
      <ul>{review.view.branches.map(branch => <li key={branch.name}>{branch.name} · {branch.pr ? `#${branch.pr.number} ${branch.pr.state}` : "new draft PR on Submit"}{branch.isMerged || branch.isQueued ? " (merged or queued; gh stack may skip)" : ""}</li>)}</ul>
      <Button variant="outline" disabled={blocked} onClick={() => setReview(undefined)}>Cancel</Button>{" "}
      <Button disabled={blocked} onClick={() => void run(review.action, { token: review.token })}>Confirm and {review.action}</Button>
    </section> : null}
  </section>;
}

function initialForm(create: StackCreate): Form {
  return { current: create.current, ...(create.trunk ? { trunk: create.trunk } : {}), branches: [create.current] };
}
