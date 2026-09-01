import type { StatusTone } from "@client/status.ts";

/**
 * The bridge from `statusTone()`'s token *name* to this front-end's palette.
 *
 * statusTone deliberately returns a meaning rather than a colour, so the TUI and the web UI can
 * agree on which meaning a status carries while each renders it its own way. The five tones and the
 * five `--color-status-*` tokens are in one-to-one correspondence by construction — the mapping
 * below is where that correspondence is written down, and it is the only place a status becomes a
 * colour in this app.
 *
 * These are `var()` references rather than class names on purpose: a tone is chosen at runtime, and
 * a class name assembled at runtime is a class name Tailwind's scanner never sees and never emits.
 */
const TONE_VARIABLE: Record<StatusTone, string> = {
  accent: "--color-status-running",
  ok: "--color-status-idle",
  dim: "--color-status-dormant",
  warn: "--color-status-settled",
  err: "--color-status-ended",
};

export function toneColor(tone: StatusTone): string {
  return `var(${TONE_VARIABLE[tone]})`;
}
