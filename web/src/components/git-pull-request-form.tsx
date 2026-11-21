import { useEffect, useState } from "react";
import type { GitChanges, GitText } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

type Props = { sessionId: string; head: string; onCreated: (url: string) => void; onCancel: () => void };

export function GitPullRequestForm({ sessionId, head, onCreated, onCancel }: Props) {
  const { connection } = useHost();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void connection.command<GitChanges>({ type: "git_changes", sessionId, view: "branch" }).then(
      (changes) => {
        const first = changes.commits.at(-1)?.replace(/^\S+ /, "");
        if (!cancelled && first) setTitle(current => current || first);
      },
      () => {},
    );
    return () => { cancelled = true; };
  }, [connection, sessionId]);

  async function suggest() {
    setBusy(true);
    setError("");
    try {
      const text = await connection.command<GitText>({ type: "suggest_git_text", sessionId, kind: "pull_request" });
      if (text.title) setTitle(current => current.trim() ? current : text.title!);
      if (text.body) setBody(current => current.trim() ? current : text.body!);
    } catch (failure) { setError(`No suggestion. ${String(failure)}`); }
    finally { setBusy(false); }
  }

  async function create() {
    setBusy(true);
    setError("");
    try { onCreated(await connection.command<string>({ type: "create_pull_request", sessionId, head, title, body, draft })); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  return (
    <form aria-label="Create pull request" className="space-y-3 border-t pt-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Create pull request</h2>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void suggest()}>Suggest</Button>
      </div>
      <label className="block space-y-1">Title<Input required value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
      <label className="block space-y-1">Body<Textarea value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} /></label>
      <label className="flex items-center gap-2"><Switch checked={draft} onCheckedChange={setDraft} disabled={busy} />Draft</label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>{busy ? "Please wait…" : "Create pull request"}</Button>
      </div>
    </form>
  );
}
