import { useEffect, useState } from "react";

import { defaultFonts } from "../../../src/protocol/fonts.ts";
import { useHost } from "@/host.tsx";
import { FALLBACK_FONTS } from "@/fonts.ts";
import { familyNames } from "@/presentation/font-family.ts";
import { SaveRow, SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * Appearance: the two typefaces.
 *
 * They exist as Settings because of a rendering failure with no other fix. A Powerline or Nerd Font
 * prompt draws its separators from the Private Use Area — U+E0B0, U+E0A0 — which no stock system
 * font carries, so a Shell renders them as tofu until it is told a font that has them. Bundling one
 * was the alternative and it is the worse trade: the right font is the one already installed on the
 * machine doing the reading, and only its owner knows which that is.
 *
 * Each field previews itself in the family it names, which is the only honest test of whether the
 * browser can resolve it — a name that resolves to nothing falls through to the next in the stack
 * silently, and a preview is how that becomes visible before saving.
 */
export function AppearanceSettings() {
  const { config } = useHost();
  const { save, saving } = useSaveSettings();

  const current = config.fonts ?? FALLBACK_FONTS;
  const [chrome, setChrome] = useState(current.chrome);
  const [monospace, setMonospace] = useState(current.monospace);

  // A reload, or a save from elsewhere, wins over what is half-typed here.
  useEffect(() => {
    setChrome(current.chrome);
    setMonospace(current.monospace);
  }, [current.chrome, current.monospace]);

  const dirty = chrome.trim() !== current.chrome || monospace.trim() !== current.monospace;

  return (
    <SettingsGroup
      title="Typefaces"
      description="A CSS font-family list. The browser uses the first family it can resolve, so name the one you want and leave a generic at the end."
    >
      <FontField
        label="Interface"
        hint="Labels, transcript prose, buttons."
        value={chrome}
        onChange={setChrome}
        preview="The quick brown fox"
        onDefault={() => setChrome(defaultFonts().chrome)}
      />

      <FontField
        label="Monospace"
        hint="The Shell's terminal, and everything that aligns character by character — Scopes, ids, counts."
        value={monospace}
        onChange={setMonospace}
        // The glyphs this Setting exists for, written as escapes so they survive every editor and
        // diff on the way here. If they render as boxes, the named font is not installed where the
        // *browser* is running — a different machine from the Session Host's often enough to be
        // worth being able to see.
        preview={"~/code \ue0b0 \ue0a0 main \ue0b0 \u2714 1234567890"}
        onDefault={() => setMonospace(defaultFonts().monospace)}
      />

      <SaveRow
        dirty={dirty}
        saving={saving}
        onSave={() =>
          void save(
            { fonts: { chrome: chrome.trim(), monospace: monospace.trim() } },
            "Typefaces saved.",
          )
        }
        onReset={() => {
          setChrome(current.chrome);
          setMonospace(current.monospace);
        }}
      />
    </SettingsGroup>
  );
}

function FontField({
  label,
  hint,
  value,
  onChange,
  preview,
  onDefault,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  preview: string;
  onDefault: () => void;
}) {
  // Taken apart the same way the browser will take it apart, which is the point of showing it: a
  // stray quote or an unclosed one silently changes where the boundaries are (font-family.ts).
  const families = familyNames(value);

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={(event) => {
              // Inside a <label>, so a click would otherwise be forwarded to the Input.
              event.preventDefault();
              onDefault();
            }}
          >
            Use the default
          </Button>
        </span>
        <span className="text-xs text-muted-foreground">{hint}</span>
        <Input
          className="font-mono text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      {/*
       * Painted in the value as typed, so an unresolvable family shows as the fallback here rather
       * than as a surprise after saving. `style` rather than a class because the value is arbitrary
       * text: the CSSOM validates it and drops a malformed one, which is the same protection
       * `applyFonts` relies on.
       */}
      <p
        aria-hidden
        className="truncate rounded-md border bg-muted/40 px-2 py-1.5 text-sm"
        style={{ fontFamily: value }}
      >
        {preview}
      </p>
      <p className="text-xs text-muted-foreground">
        {families.length} famil{families.length === 1 ? "y" : "ies"}: {families.join(" → ") || "none"}
      </p>
    </div>
  );
}
