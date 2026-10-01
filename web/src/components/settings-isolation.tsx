import { useEffect } from "react";
import { useHost } from "@/host.tsx";
import { SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";

/** The host resolves automatic mode; rendering this control never persists a fallback. */
export function IsolationSettings() {
  const { config, refresh } = useHost();
  const { save, saving } = useSaveSettings();
  const status = config.filesystemIsolationStatus;
  const checking = !status || status.checking;
  const enabled = status?.enabled ?? false;
  const supported = status?.supported ?? false;
  const automatic = status?.automatic ?? config.filesystemIsolation === undefined;
  const canEnable = !checking && supported;

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
      description="Machine-wide. Automatic mode enables isolation by default when supported; otherwise new work is unrestricted. When isolated, only the Scope and private execution state are writable."
    >
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">Enable filesystem isolation</span>
        <Switch
          aria-label="Enable filesystem isolation"
          aria-describedby="filesystem-isolation-support"
          checked={enabled}
          disabled={saving || (!enabled && !canEnable)}
          onCheckedChange={(next) => {
            if (next && !canEnable) return;
            void save(
              { filesystemIsolation: next },
              "Filesystem isolation setting saved — applies to new work.",
            );
          }}
        />
      </label>
      <p id="filesystem-isolation-support" className="text-xs text-muted-foreground" role="status">
        {checking
          ? "Checking filesystem isolation support…"
          : supported
            ? "Supported — Linux, bubblewrap (bwrap), and namespaces passed the startup check."
            : "Unsupported — filesystem isolation requires Linux, bubblewrap (bwrap), and usable namespaces."}
        {status?.reason ? ` ${status.reason}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        Support is checked at Session Host startup. Restart the host after changing Bubblewrap or namespace settings.
      </p>
      <p className="text-xs text-muted-foreground">
        {automatic ? "Automatic" : "Manual"} choice · {checking
          ? "effective mode not yet confirmed"
          : enabled
            ? supported ? "isolation enabled for new work" : "isolation requested, but cannot run on this machine"
            : "unrestricted for new work"}.
      </p>
      {!checking && enabled && !supported ? (
        <p className="text-sm text-destructive" role="alert">
          Isolation cannot be enforced on this machine. New work requiring it cannot run.
          Turn it off or reset to automatic to allow unrestricted work.
        </p>
      ) : null}
      {!enabled ? (
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
      {!checking && !supported ? (
        <p className="text-xs text-muted-foreground">
          Enabling isolation is unavailable until this machine supports it. Automatic mode uses
          unrestricted access here; it does not silently save a manual override.
        </p>
      ) : null}
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={automatic || saving}
          onClick={() => void save(
            { filesystemIsolation: null },
            "Automatic filesystem isolation restored — applies to new work.",
          )}
        >
          Reset to automatic
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Applies to new Backend Sessions (including Revive), new Workflow Executions, and new local
        MCP clients. Existing work keeps the mode it started with, including Workflow recovery.
        Revive starts a new Backend Session. No Settings tool is offered to the model.
      </p>
    </SettingsGroup>
  );
}
