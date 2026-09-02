import { displayKey, SHORTCUTS } from "@/presentation/shortcuts.ts";
import { Kbd } from "@/components/agent-session-nav.tsx";
import { SettingsGroup } from "@/components/settings-parts.tsx";

/**
 * Keyboard: every shortcut, read out of the table that resolves them.
 *
 * Read-only, and the section `?` opens — which is what that binding was resolving to nothing for
 * until there was somewhere to land. Derived from web/src/presentation/shortcuts.ts, which is held
 * against the binding table by a test, so this list cannot quietly fall behind the keys that
 * actually work.
 */
export function KeyboardSettings() {
  return (
    <>
      {SHORTCUTS.map((group) => (
        <SettingsGroup key={group.title} title={group.title} description={group.description}>
          <dl className="flex flex-col">
            {group.shortcuts.map((shortcut) => (
              <div
                key={shortcut.binding}
                className="flex items-baseline justify-between gap-4 border-b py-1.5 last:border-b-0"
              >
                <dt className="text-sm">{shortcut.description}</dt>
                <dd className="flex shrink-0 items-center gap-1">
                  {/* ⌘ on a Mac and Ctrl everywhere else come from one entry in the table, so the
                      cap says both rather than guessing which machine is reading it. */}
                  {shortcut.chord === true ? <Kbd>⌘/Ctrl</Kbd> : null}
                  {shortcut.keys.map((key) => (
                    <Kbd key={key}>{displayKey(key)}</Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </SettingsGroup>
      ))}
    </>
  );
}
