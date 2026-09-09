import { useCallback, useState } from "react";

import { clampRailWidth, parseRailWidth, railWidthStep } from "@/presentation/rail-width.ts";

/**
 * The rail's width, remembered across reloads.
 *
 * The arithmetic is in web/src/presentation/rail-width.ts, DOM-free and under test; what is left
 * here is the state and the one line that touches `localStorage`.
 *
 * Client state, not a Setting. A Setting is machine-wide and lives in the Session Host's state root
 * (src/protocol/settings.ts) — how wide you like a rail is per browser and per screen, and putting
 * it on the daemon would mean a laptop and a desktop fighting over one number.
 */
const KEY = "flow.rail-width";

export type RailWidth = {
  width: number;
  set: (px: number) => void;
  /** Nudge by one step, for the splitter's arrow keys. */
  nudge: (direction: -1 | 1, shiftKey: boolean) => void;
};

export function useRailWidth(): RailWidth {
  const [width, setWidth] = useState(() => parseRailWidth(read()));

  const set = useCallback((px: number) => {
    const next = clampRailWidth(px);
    setWidth(next);
    write(next);
  }, []);

  const nudge = useCallback(
    (direction: -1 | 1, shiftKey: boolean) => {
      // Reads through the setter rather than closing over `width`, so a held key does not compound
      // stale values and this does not have to be rebuilt on every pixel of a drag.
      setWidth((current) => {
        const next = clampRailWidth(current + direction * railWidthStep(shiftKey));
        write(next);
        return next;
      });
    },
    [],
  );

  return { width, set, nudge };
}

/**
 * Storage is a convenience here, so it is never allowed to be the thing that breaks the app: a
 * browser with storage disabled, or a full quota, has an ordinary rail rather than a blank page.
 */
function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(px: number): void {
  try {
    window.localStorage.setItem(KEY, String(px));
  } catch {
    // Nothing to do and nothing worth saying: the width still applies for this page's lifetime.
  }
}
