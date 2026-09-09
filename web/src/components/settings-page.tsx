import type { SettingsSection } from "@/presentation/route.ts";
import { GeneralSettings } from "@/components/settings-general.tsx";
import { ProjectsSettings } from "@/components/settings-projects.tsx";
import { PermissionsSettings } from "@/components/settings-permissions.tsx";
import { AppearanceSettings } from "@/components/settings-appearance.tsx";
import { KeyboardSettings } from "@/components/settings-keyboard.tsx";

/**
 * The Settings, one section at a time.
 *
 * Machine-wide, and the page says so once at the top rather than on each field: they live in the
 * Session Host's state root and govern every Agent Session on the machine, which is the thing most
 * likely to be misread in a window that is otherwise showing one Scope.
 *
 * Which section is on screen comes from the route, not from state here — reloading stays where you
 * were and a section can be linked to (web/src/presentation/route.ts).
 */
export function SettingsPage({ section }: { section: SettingsSection }) {
  return (
    <div className="transcript-scroller min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
        {/*
         * Said once, at the top, rather than on each field. Settings live in the Session Host's
         * state root, so one value governs every Agent Session on the machine — which is exactly
         * what a reader would guess wrong in a window that is otherwise showing a single Scope.
         */}
        <p className="text-xs text-muted-foreground">
          These apply to every Agent Session on this machine, not to one Scope.
        </p>

        {section === "general" ? <GeneralSettings /> : null}
        {section === "projects" ? <ProjectsSettings /> : null}
        {section === "permissions" ? <PermissionsSettings /> : null}
        {section === "appearance" ? <AppearanceSettings /> : null}
        {section === "keyboard" ? <KeyboardSettings /> : null}
      </div>
    </div>
  );
}
