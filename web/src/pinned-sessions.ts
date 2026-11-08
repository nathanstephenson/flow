import { useCallback, useState } from "react";

import { parsePinnedSessions } from "@/presentation/rail-sections.ts";

const KEY = "flow.pinned-sessions";

export type PinnedSessions = {
  pinned: ReadonlySet<string>;
  setPinned: (sessionId: string, pinned: boolean) => void;
};

export function usePinnedSessions(): PinnedSessions {
  const [pinned, setPinnedSessions] = useState(() => parsePinnedSessions(read()));

  const setPinned = useCallback((sessionId: string, isPinned: boolean) => {
    setPinnedSessions((current) => {
      if (current.has(sessionId) === isPinned) return current;
      const next = new Set(current);
      if (isPinned) next.add(sessionId);
      else next.delete(sessionId);
      write(next);
      return next;
    });
  }, []);

  return { pinned, setPinned };
}

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(pinned: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...pinned]));
  } catch {
    // The pins still apply for this page's lifetime.
  }
}
