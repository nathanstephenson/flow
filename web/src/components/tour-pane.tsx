import { useEffect, useRef, useState } from "react";
import type { TourView } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PullRequestMarkdown } from "@/components/pull-request-markdown.tsx";

export function TourPane({ sessionId }: { sessionId: string }) {
  const { connection } = useHost();
  const [view, setView] = useState<TourView>();
  const [error, setError] = useState("");
  const generation = useRef(0);

  async function send(type: "tour" | "start_tour" | "cancel_tour") {
    const current = ++generation.current;
    setError("");
    try {
      const value = await connection.command<TourView>({ type, sessionId });
      if (current === generation.current) setView(value);
    } catch (failure) { if (current === generation.current) setError(String(failure)); }
  }

  useEffect(() => { void send("tour"); }, [connection, sessionId]);
  useEffect(() => {
    if (view?.state !== "running") return;
    const timer = window.setTimeout(() => void send("tour"), 2_000);
    return () => window.clearTimeout(timer);
  }, [view]);

  const running = view?.state === "running";
  const finished = view?.state === "done" || view?.state === "failed";
  return <section aria-label="Tour" className="min-w-0 space-y-4">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold">Tour</h2>
      <div className="flex gap-2">
        {running ? <Button size="sm" variant="outline" onClick={() => void send("cancel_tour")}>Cancel</Button> : null}
        <Button size="sm" disabled={!view || running} onClick={() => void send("start_tour")}>{finished ? "Run tour again" : "Tour"}</Button>
      </div>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {view?.state === "failed" ? <p role="alert">{view.problem}</p> : null}
    {finished && view.branch && view.head ? <p className="text-xs text-muted-foreground">Made for <span className="font-mono">{view.branch}</span> at <span className="font-mono">{view.head.slice(0, 8)}</span></p> : null}
    {view === undefined ? <p>Reading tour…</p>
      : view.state === "idle" ? <p className="text-muted-foreground">A tour describes the committed changes on this branch.</p>
      : running ? <p role="status">Writing the tour…</p>
      : view.state === "done" ? <PullRequestMarkdown body={view.text} repo={view.repo} headRefName={view.head} />
      : null}
  </section>;
}
