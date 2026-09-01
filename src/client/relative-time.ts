/**
 * How long ago something happened, for the "last updated" badge both front-ends show.
 *
 * Shared with the browser the same way the reducer is: types only, so stripping leaves standalone
 * ESM. The TUI and the web UI must agree about what "2h" means, and the only way to guarantee that
 * is for there to be one implementation.
 *
 * `now` is a parameter rather than a call to the clock so a frame renders the same way twice.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";

  // Clock skew between writing the timestamp and reading it should read as recent, not negative.
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;

  // Past a day the exact age stops being what anyone wants to know; the date is. ISO because it is
  // unambiguous and locale-independent, which matters when the same string renders in a terminal.
  return new Date(at).toISOString().slice(0, 10);
}
