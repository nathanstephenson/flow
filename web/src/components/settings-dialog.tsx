import { Cpu, FolderGit2, Keyboard, LogOut, ShieldCheck, Sliders, Type } from "lucide-react";
import { useState, type ComponentType } from "react";

import { SETTINGS_SECTIONS, type SettingsSection } from "@/presentation/route.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { SettingsPage } from "@/components/settings-page.tsx";
import { cn } from "@/lib/utils.ts";
import { useHost } from "@/host.tsx";
import { useUpdates } from "@/updates.tsx";

/**
 * The Settings, as a Dialog over the Agent Session view, so the rail and the pane stay live behind it.
 *
 * **Not a tablist.** Each section is a URL you can link to and reload into, which is navigation. So
 * the section buttons say `aria-current="page"`, as the rail does.
 */
const SECTIONS: Record<SettingsSection, { label: string; hint: string; icon: ComponentType }> = {
  workflows: { label: "Workflows", hint: "Visual workflow definitions", icon: Sliders },
  mcp: { label: "MCP", hint: "Local and remote tools", icon: Sliders },
  secrets: { label: "Secrets", hint: "Named secrets and code runtime", icon: ShieldCheck },
  general: { label: "General", hint: "Updates, retention, and this host", icon: Sliders },
  projects: { label: "Projects", hint: "Where your repositories live", icon: FolderGit2 },
  permissions: { label: "Permissions", hint: "Tools allowed without asking", icon: ShieldCheck },
  providers: { label: "Providers", hint: "Which models to use", icon: Cpu },
  appearance: { label: "Appearance", hint: "The two typefaces", icon: Type },
  keyboard: { label: "Keyboard", hint: "Every shortcut", icon: Keyboard },
};

export function SettingsDialog({
  section,
  onSelect,
  onClose,
}: {
  section: SettingsSection | undefined;
  onSelect: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const { config } = useHost();
  const { status: updateStatus } = useUpdates();
  const [shown, setShown] = useState(section);
  if (section !== undefined && section !== shown) setShown(section);
  return (
    <Dialog open={section !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[80vh] sm:w-[80vw] sm:max-w-none sm:flex-row sm:rounded-[min(var(--radius-4xl),24px)]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav
          aria-label="Settings sections"
          className="transcript-scroller flex shrink-0 overflow-x-auto border-b border-border pr-12 sm:w-60 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-r sm:border-b-0 sm:py-2 sm:pr-0"
        >
          {SETTINGS_SECTIONS.map((name) => {
            const { label, hint, icon: Icon } = SECTIONS[name];
            const current = name === shown;
            return (
              <Button
                key={name}
                variant="ghost"
                aria-current={current ? "page" : undefined}
                onClick={() => onSelect(name)}
                className={cn(
                  "h-auto justify-start gap-2 rounded-none border-0 border-b-2 border-transparent px-3 py-1.5 font-normal sm:w-full sm:border-b-0 sm:border-l-2",
                  current && "border-primary bg-muted text-foreground",
                )}
              >
                <Icon aria-hidden />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm">{label}</span>
                  <span className="block truncate text-xs text-muted-foreground max-sm:hidden">{hint}</span>
                </span>
                {name === "general" && updateStatus?.updateAvailable ? (
                  <Badge variant="secondary" className="px-1.5">Update</Badge>
                ) : null}
              </Button>
            );
          })}
          {config.authentication === "oidc" ? (
            <form action="/oauth/logout" method="post" className="m-0 flex shrink-0 sm:mt-auto">
              <Button type="submit" variant="ghost" className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 font-normal">
                <LogOut aria-hidden />
                Sign out of Flow
              </Button>
            </form>
          ) : null}
        </nav>
        {shown === undefined ? null : <SettingsPage section={shown} />}
      </DialogContent>
    </Dialog>
  );
}
