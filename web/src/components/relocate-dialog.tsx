import { useId, useState } from "react";

import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { useHost } from "@/host.tsx";
import { suggestedRepository } from "@/presentation/relocate.ts";
import { useDirectoryMatches } from "@/components/settings-projects.tsx";
import { SettingsFact } from "@/components/settings-parts.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/** Bind an Agent Session whose Scope is gone to a folder the user chooses, then Revive it (ADR 0036). */
export function RelocateDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const { connection, config } = useHost();
  const [scope, setScope] = useState(session.suggestedScope ?? "");
  const [repo, setRepo] = useState(() => suggestedRepository(session.scope, config.projectList ?? []) ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const ready = scope.trim() !== "" && (!session.worktree || repo.trim() !== "");

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await connection.command({
        type: "relocate",
        sessionId: session.id,
        scope: scope.trim(),
        ...(session.worktree ? { repo: repo.trim() } : {}),
      });
      await connection.command({ type: "revive", sessionId: session.id });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Relocate Agent Session</DialogTitle>
          <DialogDescription>
            Its Scope no longer exists. Choose where its files are now.
          </DialogDescription>
        </DialogHeader>
        <SettingsFact label="Old Scope">{session.scope}</SettingsFact>
        <FolderField label="Scope" value={scope} onChange={setScope} />
        {session.worktree ? <FolderField label="Repository" value={repo} onChange={setRepo} /> : null}
        {error === undefined ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!ready || busy} onClick={() => void submit()}>Relocate and revive</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const matches = useDirectoryMatches(value);
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Input
        id={id}
        className="font-mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="/path/to/folder"
        spellCheck={false}
      />
      {matches?.paths.filter((path) => path !== value).slice(0, 5).map((path) => (
        <Button key={path} variant="ghost" size="sm" className="justify-start font-mono text-xs" onClick={() => onChange(path)}>
          {path}
        </Button>
      ))}
    </div>
  );
}
