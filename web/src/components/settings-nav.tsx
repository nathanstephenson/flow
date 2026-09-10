import { ArrowLeft, FolderGit2, Keyboard, ShieldCheck, Sliders, Type } from "lucide-react";
import type { ComponentType } from "react";

import { SETTINGS_SECTIONS, type SettingsSection } from "@/presentation/route.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The rail, while the Settings are on screen: the same frame, a different list.
 *
 * **Not a tablist**, for the reason the Agent Session rail is not one either. `role="tab"` implies a
 * set of panels, and these are routed — each one is a URL you can link to and reload into, which is
 * navigation. So they are links in the ARIA sense and say `aria-current="page"`, matching the rail's
 * `aria-current` next door rather than inventing a second vocabulary for "the one you are on".
 *
 * The footer is a way out and nothing else. It replaces the Agent Session rail's shortcut hints,
 * which name keys that do not resolve here — see `IN_SETTINGS` in web/src/presentation/bindings.ts.
 */
const SECTIONS: Record<SettingsSection, { label: string; hint: string; icon: ComponentType }> = {
  general: { label: "General", hint: "Retention, and this Session Host", icon: Sliders },
  projects: { label: "Projects", hint: "Where your repositories live", icon: FolderGit2 },
  permissions: { label: "Permissions", hint: "Tools allowed without asking", icon: ShieldCheck },
  appearance: { label: "Appearance", hint: "The two typefaces", icon: Type },
  keyboard: { label: "Keyboard", hint: "Every shortcut", icon: Keyboard },
};

export function SettingsNav({
  section,
  onSelect,
  onLeave,
}: {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onLeave: () => void;
}) {
  return (
    <>
      <SidebarHeader className="flex-row items-center gap-1 border-b border-sidebar-border">
        <span className="text-sm font-medium">Settings</span>
      </SidebarHeader>

      <SidebarContent className="transcript-scroller gap-0">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0" aria-label="Settings sections">
              {SETTINGS_SECTIONS.map((name) => {
                const { label, hint, icon: Icon } = SECTIONS[name];
                const current = name === section;
                return (
                  <SidebarMenuItem key={name}>
                    <SidebarMenuButton
                      size="lg"
                      isActive={current}
                      aria-current={current ? "page" : undefined}
                      onClick={() => onSelect(name)}
                      // Full-bleed with a left-edge marker, exactly as an Agent Session row is: the
                      // two lists sit in the same frame and must not look like two designs.
                      className={cn(
                        "rounded-none py-1.5 border-l-2 border-l-transparent",
                        current && "border-l-primary",
                      )}
                    >
                      <Icon aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border py-1.5">
        {/*
         * Back, not a browser Back: the hash is written with replaceState, so there is no history
         * entry to pop. This returns to the Agent Session that was on screen before the Settings
         * were opened — see `leaveSettings` in web/src/route.ts.
         */}
        <Button variant="ghost" size="sm" className="justify-start gap-2" onClick={onLeave}>
          <ArrowLeft aria-hidden />
          Back to Agent Sessions
        </Button>
      </SidebarFooter>
    </>
  );
}
