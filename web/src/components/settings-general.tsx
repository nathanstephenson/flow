import { useEffect, useState } from "react";

import { useAgentSessions } from "@/agent-sessions.tsx";
import { useHost } from "@/host.tsx";
import { reapableAt } from "@/presentation/reapable.ts";
import { SaveRow, SettingsFact, SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * General: the retention window, and what this Session Host is.
 *
 * Retention is the one destructive Setting. Shortening it does not delete anything on save — the
 * next sweep does, within the hour — but saving is the moment the reader decides, so this is where
 * the count belongs. It is computed from the Agent Sessions already on screen rather than asked for:
 * a summary carries `status` and `updatedAt`, which is everything the reaper uses (ADR 0006).
 */
export function GeneralSettings() {
  const { config } = useHost();
  const { sessions } = useAgentSessions();
  const { save, saving } = useSaveSettings();

  const current = config.retention?.settled;
  const [settled, setSettled] = useState(current ?? "");
  const [confirming, setConfirming] = useState(false);

  // A save elsewhere, or a reload, is the source of truth — not what is half-typed here.
  useEffect(() => setSettled(current ?? ""), [current]);

  if (current === undefined) {
    return (
      <SettingsGroup title="Retention">
        <p className="text-sm text-muted-foreground">This Session Host serves no Settings.</p>
      </SettingsGroup>
    );
  }

  const dirty = settled.trim() !== current;
  // What the next sweep would take under the *proposed* window, which is the number the reader is
  // actually deciding about. Anything already doomed under the current one is not news.
  const now = Date.now();
  const newlyDoomed =
    reapableAt(sessions, settled.trim(), now).length - reapableAt(sessions, current, now).length;

  const commit = (): void => {
    setConfirming(false);
    void save({ retention: { settled: settled.trim() } }, "Retention saved — it applies at the next sweep.");
  };

  return (
    <>
      <SettingsGroup
        title="Retention"
        description={
          <>
            How long a Settled Agent Session survives before it is reaped. A duration —{" "}
            <code className="font-mono text-xs">90m</code>,{" "}
            <code className="font-mono text-xs">36h</code>,{" "}
            <code className="font-mono text-xs">1d</code> — or{" "}
            <code className="font-mono text-xs">never</code> to keep them all. Only Settled Agent
            Sessions are ever reaped; an Ended one stays on disk.
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Settled Agent Sessions</span>
          <Input
            className="font-mono"
            value={settled}
            onChange={(event) => setSettled(event.target.value)}
            placeholder="1d"
            spellCheck={false}
          />
        </label>

        <p className="text-xs text-muted-foreground">
          The Session Host sweeps once an hour, so a change applies within the hour rather than now.
        </p>

        <SaveRow
          dirty={dirty}
          saving={saving}
          onSave={() => (newlyDoomed > 0 ? setConfirming(true) : commit())}
          onReset={() => setSettled(current)}
        />
      </SettingsGroup>

      <SettingsGroup title="This Session Host">
        <div className="flex flex-col">
          <SettingsFact label="Default Scope">{config.scope}</SettingsFact>
          <SettingsFact label="Backends">{config.backends.join(", ") || "none"}</SettingsFact>
          <SettingsFact label="Shells">{config.shell ? "available" : "unavailable"}</SettingsFact>
          <SettingsFact label="Settings file">&lt;state root&gt;/config.json</SettingsFact>
        </div>
      </SettingsGroup>

      {/*
       * The app's second confirm, and it follows the first one's rules (agent-session-pane-header):
       * it states what is lost, it counts it, and its action button says the thing it does. Shown
       * only when the new window reaches Agent Sessions the old one did not — re-saving a window
       * that already dooms something is not a new decision.
       */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              This reaps {newlyDoomed} Agent Session{newlyDoomed === 1 ? "" : "s"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {newlyDoomed === 1 ? "One Settled Agent Session is" : `${newlyDoomed} Settled Agent Sessions are`}{" "}
              older than {settled.trim()}, so the next sweep will delete{" "}
              {newlyDoomed === 1 ? "its Presentation Transcript" : "their Presentation Transcripts"} from
              disk. That happens within the hour, not now, and it cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the old window</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={commit}>
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
