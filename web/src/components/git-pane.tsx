import { useEffect, useRef, useState } from "react";
import type { ChangesView, PushState } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { StackPane } from "@/components/stack-pane.tsx";
import { GitChanges } from "@/components/git-changes.tsx";
import { GitPullRequestForm } from "@/components/git-pull-request-form.tsx";
import { PullRequestPane } from "@/components/pull-request-pane.tsx";
import type { AppendResult } from "@/components/composer.tsx";
import { safePullRequestUrl } from "@/presentation/pull-request.ts";
import { branchLine, gitStateLine, gitSteps, pullRequestLine, pullStep, stepLabels, type GitStep } from "@/presentation/git.ts";
import { useGitState } from "@/git-state.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";

type Tab = "Changes" | "Stack" | "PR";
type Reads = { changes: number; stack: number; pullRequest: number; mount: number };
type Step = { kind: "replace"; state: PushState } | { kind: "pull_request"; head: string };
type Notice = { text: string; url?: string };

export function GitPane({ sessionId, onAddToDraft }: { sessionId: string; onAddToDraft: (block: string) => AppendResult }) {
  const { connection } = useHost();
  const git = useGitState(sessionId);
  const prKey = JSON.stringify(git?.pr ?? null);
  const seenPrKey = useRef(prKey);
  const [reads, setReads] = useState<Reads>({ changes: 0, stack: 0, pullRequest: 0, mount: 0 });
  const [view, setView] = useState<ChangesView>("uncommitted");
  const [step, setStep] = useState<Step>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [hasPr, setHasPr] = useState(false);
  const [hasStack, setHasStack] = useState(false);
  const [tab, setTab] = useState<Tab>();
  const tabs: Tab[] = ["Changes", ...(hasStack ? ["Stack" as const] : []), ...(hasPr ? ["PR" as const] : [])];
  const selected = tab === "Changes" || (tab === "Stack" && hasStack) || (tab === "PR" && hasPr) ? tab : tab === undefined && hasPr ? "PR" : "Changes";
  const steps = gitSteps(git);
  const pullOffer = pullStep(git);

  function reread(...keys: (keyof Reads)[]) {
    setReads(current => ({ ...current, ...Object.fromEntries(keys.map(key => [key, current[key] + 1])) }));
  }

  useEffect(() => {
    if (seenPrKey.current === prKey) return;
    seenPrKey.current = prKey;
    reread("stack");
  }, [prKey]);

  async function run(work: () => Promise<Notice | void>) {
    setBusy(true);
    setError("");
    setNotice(undefined);
    try { setNotice(await work() ?? undefined); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  async function push(state: PushState, replace?: string) {
    await connection.command({ type: "push", sessionId, head: state.head, ...(replace ? { replace } : {}) });
    setStep(undefined);
    return { text: `Pushed ${state.branch}.` };
  }

  function open(value: GitStep) {
    setError("");
    setNotice(undefined);
    if (value === "commit") {
      setStep(undefined);
      setTab("Changes");
      setView("uncommitted");
    } else if (value === "pull_request") setStep({ kind: "pull_request", head: git!.head! });
    else void run(async () => {
      const state = await connection.command<PushState>({ type: "push_state", sessionId });
      if (state.replaced.length === 0) return push(state);
      setStep({ kind: "replace", state });
    });
  }

  function refresh() {
    reread("changes", "stack", "pullRequest");
    void run(() => connection.command({ type: "refresh_git", sessionId, pullRequest: true }));
  }

  function pull() {
    void run(async () => {
      await connection.command({ type: "pull_branch", sessionId, branch: git!.branch! });
      reread("stack", "pullRequest");
    });
  }

  return (
    <Tabs
      value={selected}
      onValueChange={(value) => {
        if (!busy && (value === "Changes" || value === "Stack" && hasStack || value === "PR" && hasPr)) setTab(value);
      }}
      className="min-h-0 min-w-0 space-y-4 overflow-auto px-4 pb-4 text-sm"
    >
      <header aria-label="Git state" className="space-y-2 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="min-w-0 flex-1 truncate">{git ? branchLine(git) : "Git"}</strong>
          <Button size="xs" variant="ghost" disabled={busy} onClick={refresh}>Refresh</Button>
        </div>
        {git ? (
          <p className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{gitStateLine(git)}</span>
            {git.pr ? <a className="underline" href={safePullRequestUrl(git.pr.url)} target="_blank" rel="noreferrer">{pullRequestLine(git.pr)}</a> : null}
          </p>
        ) : null}
        {typeof pullOffer === "object" ? <p className="text-xs text-muted-foreground">{pullOffer.diverged}</p> : null}
        {steps.length > 0 || pullOffer === "pull" ? (
          <div className="flex flex-wrap gap-2">
            {steps.map((value, index) => (
              <Button key={value} size="sm" variant={index === 0 ? "default" : "outline"} disabled={busy} onClick={() => open(value)}>{stepLabels[value]}</Button>
            ))}
            {pullOffer === "pull" ? <Button size="sm" variant="outline" disabled={busy} onClick={pull}>Pull</Button> : null}
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status" className="break-all">{notice.text}{notice.url ? <> <a className="underline" href={safePullRequestUrl(notice.url)} target="_blank" rel="noreferrer">{notice.url}</a></> : null}</p> : null}
      </header>
      {step?.kind === "replace" ? (
        <section aria-label="Confirm push" className="space-y-3 border-t pt-3">
          <h2 className="font-medium">Replace remote commits</h2>
          <p>The remote branch {step.state.branch} has commits that this branch does not have. The push replaces them:</p>
          <ul className="space-y-0.5 font-mono text-xs">{step.state.replaced.map(commit => <li key={commit} className="truncate">{commit}</li>)}</ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setStep(undefined)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => push(step.state, step.state.remote))}>Replace and push</Button>
          </div>
        </section>
      ) : null}
      {step?.kind === "pull_request" ? (
        <GitPullRequestForm
          sessionId={sessionId}
          head={step.head}
          onCancel={() => setStep(undefined)}
          onCreated={(url) => { setStep(undefined); setNotice({ text: "Pull request created:", url }); }}
        />
      ) : null}
      <div>
        <TabsList aria-label="Git views" className="flex w-full min-w-0">
          {tabs.map(value => (
            <TabsTrigger key={value} value={value} className="min-w-0 flex-1 shrink px-2" disabled={busy}>{value}</TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="Changes" keepMounted className="space-y-4">
        <GitChanges
          sessionId={sessionId}
          revision={`${git?.revision}:${reads.changes}`}
          view={view}
          onViewChange={setView}
          onCommitted={(commit) => setNotice({ text: `Committed ${commit.slice(0, 7)}.` })}
        />
      </TabsContent>
      <TabsContent value="Stack" keepMounted>
        <StackPane key={sessionId} sessionId={sessionId} revision={reads.stack} disabled={busy} onAvailable={setHasStack} onChange={() => { setHasPr(false); reread("stack", "mount"); }} />
      </TabsContent>
      <TabsContent value="PR" keepMounted>
        <PullRequestPane key={`${sessionId}:${reads.mount}`} sessionId={sessionId} revision={reads.pullRequest} summary={git?.pr} disabled={busy} onAvailable={setHasPr} onChange={() => reread("stack")} onAddToDraft={onAddToDraft} />
      </TabsContent>
    </Tabs>
  );
}
