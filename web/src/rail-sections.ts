import { useCallback, useState } from "react";

import { parseOpenSections, type CollapsibleRailSection } from "@/presentation/rail-sections.ts";

const KEY = "flow.rail-open-sections";

export type RailSections = {
  open: ReadonlySet<CollapsibleRailSection>;
  setOpen: (section: CollapsibleRailSection, open: boolean) => void;
};

export function useRailSections(): RailSections {
  const [open, setOpenSections] = useState(() => parseOpenSections(read()));

  const setOpen = useCallback((section: CollapsibleRailSection, isOpen: boolean) => {
    setOpenSections((current) => {
      if (current.has(section) === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.add(section);
      else next.delete(section);
      write(next);
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

function write(open: ReadonlySet<CollapsibleRailSection>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...open]));
  } catch {
    // The sections still apply for this page's lifetime.
  }
}
