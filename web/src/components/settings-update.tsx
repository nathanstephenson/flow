import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Download, LoaderCircle, RotateCw } from "lucide-react";

import { useUpdates } from "@/updates.tsx";
import { canStartUpdate, updateDetail, updatePresentation } from "@/presentation/update.ts";
import type { UpdateChannel } from "../../../src/protocol/update.ts";
import { SettingsFact, SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
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

const CHANNELS: Record<UpdateChannel, string> = { stable: "Stable", beta: "Beta" };

export function UpdateSettings() {
  const { status, view, transportError, check, begin } = useUpdates();
  const { save, saving } = useSaveSettings();
  const [confirmingVersion, setConfirmingVersion] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const presentation = updatePresentation(status, view, transportError ?? actionError);
  const detail = updateDetail(presentation, status, { actionError, transportError });

  // Opening General checks again, while still sharing the Session Host's 15-minute cache.
  useEffect(() => { void check(false); }, []);

  const working = ["checking", "updating", "reconnecting"].includes(presentation);
  const canUpdate = canStartUpdate(status, presentation);
  const updateVersion = canUpdate ? status?.latestVersion : undefined;
  const changeChannel = async (channel: UpdateChannel) => {
    setActionError(undefined);
    if (await save({ updateChannel: channel }, `${CHANNELS[channel]} channel saved.`)) await check(false);
  };
  const confirm = async (version: string) => {
    setConfirmingVersion(undefined);
    setActionError(undefined);
    try { await begin(version); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Could not start the update"); }
  };

  return (
    <>
      <SettingsGroup
        title="Flow update"
        description="Discover and install the latest npm release for the selected channel. Updates are never automatic."
      >
        <Select
          value={status?.channel ?? "stable"}
          disabled={saving || working || !status}
          onValueChange={(next) => { if (next === "stable" || next === "beta") void changeChannel(next); }}
        >
          <SelectTrigger className="w-full sm:max-w-sm" aria-label="Release channel">
            <SelectValue>{CHANNELS[status?.channel ?? "stable"]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">{CHANNELS.stable}</SelectItem>
            <SelectItem value="beta">{CHANNELS.beta}</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex flex-col">
          <SettingsFact label="Installed">{status?.installedVersion ?? "checking…"}</SettingsFact>
          <SettingsFact label="Latest">{status?.latestVersion ?? (status?.checkError ? "check failed" : "checking…")}</SettingsFact>
        </div>

        <div
          className="flex items-start gap-2 rounded-xl border bg-muted/35 px-3 py-2.5 text-sm"
          role="status"
          aria-live="polite"
          data-update-state={presentation}
        >
          {working ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
            : presentation === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            : ["error", "failure", "recovery-needed", "blocked", "unsupported"].includes(presentation)
              ? <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              : <Download className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{labelFor(presentation)}</span>
              {status?.updateAvailable ? <Badge variant="secondary">{status.latestVersion} available</Badge> : null}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={working} onClick={() => { setActionError(undefined); void check(true); }}>
            <RotateCw aria-hidden />
            Check for updates
          </Button>
          {updateVersion ? (
            <Button size="sm" onClick={() => setConfirmingVersion(updateVersion)}>
              <Download aria-hidden />
              Update to {updateVersion}
            </Button>
          ) : null}
          {presentation === "recovery-needed" ? (
            <Button size="sm" onClick={() => { setActionError(undefined); void check(false); }}>Reconnect</Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Stable offers <code className="font-mono">@nathanstephenson/flow@latest</code>. Beta offers the higher of the <code className="font-mono">latest</code> and <code className="font-mono">beta</code> tags. Downgrades are not offered, so after you switch back to Stable, Flow waits for a newer stable release. Custom paths and force updates are not offered.
        </p>
      </SettingsGroup>

      <AlertDialog open={confirmingVersion !== undefined} onOpenChange={open => { if (!open) setConfirmingVersion(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update Flow to {confirmingVersion}?</AlertDialogTitle>
            <AlertDialogDescription>
              Flow will temporarily disconnect this browser and restart the Session Host. Durable Agent Sessions and Presentation Transcripts stay on disk, but Agent Sessions return Dormant and are not Revived automatically. Ephemeral Shells are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirmingVersion) void confirm(confirmingVersion); }}>Update and restart</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function labelFor(state: ReturnType<typeof updatePresentation>): string {
  return {
    checking: "Checking",
    "up-to-date": "Up to date",
    available: "Update available",
    unsupported: "Manual update required",
    blocked: "Update blocked",
    updating: "Updating",
    reconnecting: "Reconnecting",
    success: "Update complete",
    failure: "Update failed",
    "recovery-needed": "Recovery needs attention",
    error: "Check failed",
  }[state];
}
