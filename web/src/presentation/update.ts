import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
export const OPEN_BROWSER_UPDATE_CHECK_MS = 60 * 60 * 1000;
export const UPDATE_RECONNECT_LIMIT_MS = 30 * 1000;
export const UPDATE_RECONNECT_POLL_MS = 2 * 1000;
export const UPDATE_RECOVERY_POLL_MS = 10 * 1000;

export type UpdateViewState = "checking" | "ready" | "starting" | "reconnecting" | "recovery-needed";

export type UpdatePresentation =
  | "checking"
  | "up-to-date"
  | "available"
  | "unsupported"
  | "blocked"
  | "updating"
  | "reconnecting"
  | "success"
  | "failure"
  | "recovery-needed"
  | "error";

export function reconnectView(startedAt: number, now: number): UpdateViewState {
  return now - startedAt >= UPDATE_RECONNECT_LIMIT_MS ? "recovery-needed" : "reconnecting";
}

/** Keep checking through repeated identical failures; stop only when the caller leaves reconnect mode. */
export async function pollUpdateChecks(options: {
  active(): boolean;
  delay(): number;
  wait(delayMs: number): Promise<void>;
  check(): Promise<void>;
}): Promise<void> {
  while (options.active()) {
    await options.wait(options.delay());
    if (!options.active()) return;
    await options.check();
  }
}

export function updatePresentation(status: WebUpdateStatus | undefined, view: UpdateViewState, transportError?: string): UpdatePresentation {
  if (view === "starting") return "updating";
  if (view === "reconnecting") return "reconnecting";
  if (view === "recovery-needed") return "recovery-needed";
  if (status?.operation?.state === "updating") return "updating";
  if (status?.operation?.state === "unverified") return "recovery-needed";
  if (view === "checking") return "checking";
  if (transportError || status?.checkError) return "error";
  if (status?.operation?.state === "failed") return "failure";
  // A successful operation is historical once discovery finds another eligible release.
  if (status?.eligibility.state === "eligible" && status.updateAvailable) return "available";
  if (status?.operation?.state === "succeeded") return "success";
  if (status?.eligibility.state === "unsupported") return "unsupported";
  if (status?.eligibility.state === "blocked") return "blocked";
  return status?.updateAvailable ? "available" : "up-to-date";
}

export function canStartUpdate(status: WebUpdateStatus | undefined, presentation: UpdatePresentation): boolean {
  return status?.eligibility.state === "eligible" && status.updateAvailable && status.latestVersion !== undefined && ["available", "failure"].includes(presentation);
}
