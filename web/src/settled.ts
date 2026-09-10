import { useEffect, useState } from "react";

/**
 * A value once it has stopped changing.
 *
 * The New Agent Session view's Scope is a free-text path, so anything asked about it — is this a
 * repository, what could be cut from it — would otherwise be asked once per keystroke. This is the
 * same restraint `/api/directories` earns by being a query: cheap to ask, but not worth asking
 * mid-word.
 */
export function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
