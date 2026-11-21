import { useEffect, useRef, useState } from "react";
import type { ChangesView, PushState } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { StackPane } from "@/components/stack-pane.tsx";
import { GitChanges } from "@/components/git-changes.tsx";
import { GitPullRequestForm } from "@/components/git-pull-request-form.tsx";
import { PullRequestPane } from "@/components/pull-request-pane.tsx";
import { safePullRequestUrl } from "@/presentation/pull-request.ts";
import { branchLine, gitStateLine, gitSteps, pullRequestLine, stepLabels, type GitStep } from "@/presentation/git.ts";
import { useGitState } from "@/git-state.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";

type Tab = "Changes" | "Stack" | "PR";
type Reads = { changes: number; stack: number; pullRequest: number; mount: number };

export function GitPane({ sessionId }: { sessionId: string }) {
  const { connection } = useHost();
  const git = useGitState(sessionId);
  const prKey = JSON.stringify(git?.pr ?? null);
  const seenPrKey = useRef(prKey);
  const [reads, setReads] = useState<Reads>({ changes: 0, stack: 0, pullRequest: 0, mount: 0 });
  const [view, setView] = useState<ChangesView>("uncommitted");
  const [defaultBranch, setDefaultBranch] = useState<string>();
  const [step, setStep] = useState<"replace" | "pull_request">();
  const [pushing, setPushing] = useState<PushState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hasPr, setHasPr] = useState(false);
  const [hasStack, setHasStack] = useState(false);
  const [tab, setTab] = useState<Tab>();
  const tabs: Tab[] = ["Changes", ...(hasStack ? ["Stack" as const] : []), ...(hasPr ? ["PR" as const] : [])];
  const selected = tab === "Changes" || (tab === "Stack" && hasStack) || (tab === "PR" && hasPr) ? tab : tab === undefined && hasPr ? "PR" : "Changes";
  const steps = gitSteps(git, defaultBranch);

  function reread(...keys: (keyof Reads)[]) {
    setReads(current => ({ ...current, ...Object.fromEntries(keys.map(key => [key, current[key] + 1])) }));
  }

  useEffect(() => {
    if (seenPrKey.current === prKey) return;
    seenPrKey.current = prKey;
    reread("stack", "pullRequest");
  }, [prKey]);

  async function run(work: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { setNotice(await work() ?? ""); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  async function push(state: PushState, replace?: string) {
    await connection.command({ type: "push", sessionId, head: state.head, ...(replace ? { replace } : {}) });
    setStep(undefined);
    return `Pushed ${state.branch}.`;
  }

  function open(value: GitStep) {
    setError("");
    setNotice("");
    if (value === "commit") {
      setStep(undefined);
      setTab("Changes");
      setView("uncommitted");
    } else if (value === "pull_request") setStep("pull_request");
    else void run(async () => {
      const state = await connection.command<PushState>({ type: "push_state", sessionId });
      if (state.replaced.length === 0) return push(state);
      setPushing(state);
      setStep("replace");
    });
  }

  function refresh() {
    reread("changes", "stack", "pullRequest");
    void run(() => connection.command({ type: "refresh_git", sessionId }));
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
        {steps.length > 0 || (git?.branch && git.behind > 0 && git.changed === 0) ? (
          <div className="flex flex-wrap gap-2">
            {steps.map((value, index) => (
              <Button key={value} size="sm" variant={index === 0 ? "default" : "outline"} disabled={busy} onClick={() => open(value)}>{stepLabels[value]}</Button>
            ))}
            {git?.branch && git.behind > 0 && git.changed === 0 ? <Button size="sm" variant="outline" disabled={busy} onClick={pull}>Pull</Button> : null}
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
      </header>
      {step === "replace" && pushing ? (
        <section aria-label="Confirm push" className="space-y-3 border-t pt-3">
          <h2 className="font-medium">Replace remote commits</h2>
          <p>The remote branch {pushing.branch} has commits that this branch does not have. The push replaces them:</p>
          <ul className="space-y-0.5 font-mono text-xs">{pushing.replaced.map(commit => <li key={commit} className="truncate">{commit}</li>)}</ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setStep(undefined)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => push(pushing, pushing.remote))}>Replace and push</Button>
          </div>
        </section>
      ) : null}
      {step === "pull_request" && git?.head ? (
        <GitPullRequestForm
          sessionId={sessionId}
          head={git.head}
          onCancel={() => setStep(undefined)}
          onCreated={(url) => { setStep(undefined); setNotice(`Pull request created: ${url}`); }}
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
          onDefaultBranch={setDefaultBranch}
          onCommitted={(commit) => setNotice(`Committed ${commit.slice(0, 7)}.`)}
        />
      </TabsContent>
      <TabsContent value="Stack" keepMounted>
        <StackPane key={sessionId} sessionId={sessionId} revision={reads.stack} disabled={busy} onAvailable={setHasStack} onChange={() => { setHasPr(false); reread("stack", "mount"); }} />
      </TabsContent>
      <TabsContent value="PR" keepMounted>
        <PullRequestPane key={`${sessionId}:${reads.mount}`} sessionId={sessionId} revision={reads.pullRequest} disabled={busy} onAvailable={setHasPr} onChange={() => reread("stack")} />
      </TabsContent>
    </Tabs>
  );
}
