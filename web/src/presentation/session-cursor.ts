import type { SessionSummary } from "../../../src/protocol/commands.ts";

/** Keep the keyboard cursor attached to an Agent Session while attention reorders the list. */
export function retainSessionCursor(
  previous: readonly SessionSummary[],
  sessions: readonly SessionSummary[],
  current: string | undefined,
): string | undefined {
  if (current && sessions.some((session) => session.id === current)) return current;
  const index = Math.max(0, previous.findIndex((session) => session.id === current));
  return sessions[Math.min(index, sessions.length - 1)]?.id;
}

export function moveSessionCursor(
  sessions: readonly SessionSummary[],
  current: string | undefined,
  step: number,
): string | undefined {
  if (sessions.length === 0) return undefined;
  const found = sessions.findIndex((session) => session.id === current);
  const index = found < 0 ? 0 : found;
  return sessions[Math.max(0, Math.min(sessions.length - 1, index + step))]?.id;
}
