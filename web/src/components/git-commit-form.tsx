import { useState, type Dispatch, type SetStateAction } from "react";
import type { GitText, GitTextKind } from "../../../src/protocol/git.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

type Props = {
  sessionId: string;
  paths: string[];
  fingerprint: string;
  branch: string | undefined;
  defaultBranch: string | undefined;
  canRename: boolean;
  message: string;
  branchName: string;
  onMessage: Dispatch<SetStateAction<string>>;
  onBranchName: Dispatch<SetStateAction<string>>;
  onCommitted: (commit: string) => void;
};

export function GitCommitForm({ sessionId, paths, fingerprint, branch, defaultBranch, canRename, message, branchName: name, onMessage: setMessage, onBranchName: setName, onCommitted }: Props) {
  const { connection } = useHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const newBranch = branch === undefined || branch === defaultBranch;

  async function suggest(kind: GitTextKind) {
    setBusy(true);
    setError("");
    try {
      const text = await connection.command<GitText>({ type: "suggest_git_text", sessionId, kind, paths });
      if (text.message) setMessage(current => current.trim() ? current : text.message!);
      if (text.branch) setName(current => current.trim() ? current : text.branch!);
    } catch (failure) { setError(`No suggestion. ${String(failure)}`); }
    finally { setBusy(false); }
  }

  async function commit() {
    setBusy(true);
    setError("");
    try {
      const id = await connection.command<string>({ type: "commit", sessionId, fingerprint, paths, message, ...(name.trim() ? { branch: name.trim() } : {}) });
      setMessage("");
      setName("");
      onCommitted(id);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  return (
    <form aria-label="Commit" className="space-y-3 border-t pt-3" onSubmit={(event) => { event.preventDefault(); void commit(); }}>
      {newBranch || canRename ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${sessionId}-branch`}>{newBranch ? "New branch name" : "Rename branch (optional)"}</label>
            <Button type="button" size="xs" variant="ghost" aria-label="Suggest branch name" disabled={busy || paths.length === 0} onClick={() => void suggest("branch")}>Suggest</Button>
          </div>
          <Input id={`${sessionId}-branch`} required={newBranch} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
          {newBranch ? <p className="text-xs text-muted-foreground">{branch ? `${branch} is the default branch.` : "HEAD is detached."} The commit goes on a new branch.</p> : null}
        </div>
      ) : null}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`${sessionId}-message`}>Commit message</label>
          <Button type="button" size="xs" variant="ghost" aria-label="Suggest commit message" disabled={busy || paths.length === 0} onClick={() => void suggest("commit")}>Suggest</Button>
        </div>
        <Textarea id={`${sessionId}-message`} required value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} />
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" size="sm" disabled={busy || paths.length === 0 || !message.trim() || (newBranch && !name.trim())}>
        {busy ? "Please wait…" : `Commit ${paths.length} ${paths.length === 1 ? "file" : "files"}`}
      </Button>
    </form>
  );
}
