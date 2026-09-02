import { useEffect, useState } from "react";

/**
 * A clock that ticks slowly, for relative times.
 *
 * `relativeTime` takes `now` as a parameter precisely so a frame renders identically twice, and
 * below an hour its output changes at most once a minute — so piggybacking this on the two-second
 * Agent Session poll would be pure waste. One timer at the sidebar level feeds every row.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
