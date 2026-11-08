import { useCallback, useState } from "react";

import { parseOpenSection, type CollapsibleRailSection } from "@/presentation/rail-sections.ts";

const KEY = "flow.rail-open-section";

export type RailSections = {
  open: CollapsibleRailSection | undefined;
  setOpen: (section: CollapsibleRailSection, open: boolean) => void;
};

export function useRailSections(): RailSections {
  const [open, setOpenSection] = useState(() => parseOpenSection(read()));

  const setOpen = useCallback((section: CollapsibleRailSection, isOpen: boolean) => {
    setOpenSection((current) => {
      const next = isOpen ? section : current === section ? undefined : current;
      if (next !== current) write(next);
      return next;
    });
  }, []);

  return { open, setOpen };
}

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(open: CollapsibleRailSection | undefined): void {
  try {
    if (open) window.localStorage.setItem(KEY, open);
    else window.localStorage.removeItem(KEY);
  } catch {
    // The open section still applies for this page's lifetime.
  }
}
