import { useCallback, useState, type ReactNode } from "react";

import type { SettingsPatch } from "../../../src/protocol/settings.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { toast } from "@/components/ui/toaster.tsx";

/**
 * The furniture every section of the Settings is built from.
 *
 * Its own module rather than living beside the page, because the page picks which section to render
 * and each section needs these — putting them together makes the two import each other, which works
 * in ESM only by accident of hoisting.
 */

/** A titled block with its own explanation. Every section is made of these. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description === undefined ? null : (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

/** A read-only fact about this Session Host, in the same two-column shape throughout. */
export function SettingsFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs">{children}</span>
    </div>
  );
}

/**
 * Saving, and what it does about being refused.
 *
 * The daemon validates and answers 400 with a message naming the field, rather than warning and
 * keeping the old value the way it does for the file on disk. That message is the useful one, so it
 * is shown verbatim — a settings page that reports success while quietly keeping the old value is
 * the one behaviour worth engineering against.
 */
export function useSaveSettings(): {
  save: (patch: SettingsPatch, announced: string) => Promise<boolean>;
  saving: boolean;
} {
  const { saveSettings } = useHost();
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (patch: SettingsPatch, announced: string): Promise<boolean> => {
      setSaving(true);
      try {
        await saveSettings(patch);
        toast.info(announced);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save the Settings");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saveSettings],
  );

  return { save, saving };
}

/** The one shape a section's save control takes: disabled until something differs. */
export function SaveRow({
  dirty,
  saving,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={onReset}>
        Discard
      </Button>
    </div>
  );
}
