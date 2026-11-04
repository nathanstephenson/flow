import { useEffect, type ComponentProps } from "react";
import type { FilesystemIsolationMode, SandboxSharing } from "../../../src/protocol/settings.ts";
import { useHost } from "@/host.tsx";
import { SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";

const AUTOMATIC = "automatic";
const LABELS: Record<FilesystemIsolationMode, string> = {
  none: "Unrestricted",
  bubblewrap: "Bubblewrap",
  sandbox: "Sandbox",
};
const SHARING: Record<SandboxSharing, string> = {
  session: "One VM per session",
  shared: "One VM for all sessions",
};

function TipItem({ tip, ...props }: ComponentProps<typeof SelectItem> & { tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>
        <SelectItem {...props} />
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** The host resolves automatic mode; rendering this control never persists a fallback. */
export function IsolationSettings() {
  const { config, refresh } = useHost();
  const { save, saving } = useSaveSettings();
  const status = config.filesystemIsolationStatus;
  const checking = !status || status.checking;
  const choice = config.filesystemIsolation;
  const automatic = status?.automatic ?? choice === undefined;
  const mode = status?.mode ?? choice ?? "none";
  const supported = status?.supported ?? false;
  const sandboxSupported = status?.sandbox.supported ?? false;
  const enforceable = mode === "bubblewrap" ? supported : mode === "sandbox" ? sandboxSupported : true;
  const sharing = config.sandboxSharing ?? "session";
  const projectRoot = config.projects?.root;
  const automaticLabel = `Automatic — ${checking ? "checking…" : LABELS[mode]}`;
  const bubblewrapTip = `${checking
    ? "Checking support…"
    : supported
      ? "Supported: Linux, bwrap and namespaces passed the startup check."
      : `Unsupported: needs Linux, bubblewrap (bwrap) and usable namespaces.${status?.reason ? ` ${status.reason}` : ""}`} Checked at Session Host start.`;
  const sandboxTip = sandboxSupported
    ? `Provider: ${status?.sandbox.path ?? ""}`
    : `Unsupported.${status?.sandbox.reason ? ` ${status.sandbox.reason}` : ""}`;

  // The launch probe can finish after the first config response. Refresh its answer, without
  // writing a preference or inferring a fallback in the browser.
  useEffect(() => {
    if (!status?.checking) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [status?.checking, refresh]);

  return (
    <SettingsGroup
      title="Filesystem isolation"
      description="Machine-wide. Unrestricted gives no isolation. Bubblewrap and Sandbox let only the Scope and private execution state be written. Automatic uses Bubblewrap when supported; otherwise new work is unrestricted."
    >
      <Select
        value={automatic ? AUTOMATIC : mode}
        disabled={saving}
        onValueChange={(next) => {
          if (next === AUTOMATIC) {
            void save({ filesystemIsolation: null }, "Automatic filesystem isolation restored — applies to new work.");
          } else if (next === "none" || next === "bubblewrap" || next === "sandbox") {
            void save({ filesystemIsolation: next }, "Filesystem isolation setting saved — applies to new work.");
          }
        }}
      >
        <SelectTrigger
          className="w-full sm:max-w-sm"
          aria-label="Filesystem isolation mode"
        >
          <SelectValue>{automatic ? automaticLabel : LABELS[mode]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTOMATIC}>{automaticLabel}</SelectItem>
          <SelectItem value="none">{LABELS.none}</SelectItem>
          <TipItem value="bubblewrap" tip={bubblewrapTip} disabled={(checking || !supported) && choice !== "bubblewrap"}>
            {LABELS.bubblewrap}
          </TipItem>
          <TipItem value="sandbox" tip={sandboxTip} disabled={!sandboxSupported && choice !== "sandbox"}>
            {LABELS.sandbox}
          </TipItem>
        </SelectContent>
      </Select>
      {mode === "sandbox" ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Sandbox sharing</span>
          <Select
            value={sharing}
            disabled={saving}
            onValueChange={(next) => {
              if (next === "session" || next === "shared") void save({ sandboxSharing: next }, "Sandbox sharing saved — applies to new work.");
            }}
          >
            <SelectTrigger className="w-full sm:max-w-sm" aria-label="Sandbox sharing">
              <SelectValue>{SHARING[sharing]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="session">{SHARING.session}</SelectItem>
              <TipItem
                value="shared"
                tip={`Scopes must be under the Project Root${projectRoot ? ` ${projectRoot}` : ""} or the Worktrees folder. Every session in the VM can read and write the others' files.`}
              >
                {SHARING.shared}
              </TipItem>
            </SelectContent>
          </Select>
          {sharing === "shared" && !projectRoot ? (
            <p className="text-sm text-destructive" role="alert">Set a Project Root first. Until then, sandbox sessions cannot start.</p>
          ) : null}
        </div>
      ) : null}
      {!checking && !enforceable ? (
        <p className="text-sm text-destructive" role="alert">
          Isolation cannot be enforced on this machine. New work requiring it cannot run.
          Choose another mode or Automatic to allow unrestricted work.
        </p>
      ) : null}
      {mode === "none" ? (
        <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          <p className="font-semibold">Unrestricted filesystem access{checking ? " may be in effect" : " for new work"}</p>
          <p>
            Without isolation, agent tools, Workflow Shell steps, and local stdio MCP
            clients can write or delete files outside the Scope and access host credentials.
            Scope is only a working directory, not a security boundary. TypeScript's scoped API
            remains restricted, but its supervisor is not OS-confined.
          </p>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Applies to new Backend Sessions (including Revive), new Workflow Executions, and new local
        MCP clients. Existing work keeps the mode it started with, including Workflow recovery.
        Revive starts a new Backend Session. No Settings tool is offered to the model.
      </p>
    </SettingsGroup>
  );
}
