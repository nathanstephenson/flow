import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
export const OPEN_BROWSER_UPDATE_CHECK_MS = 60 * 60 * 1000;
export const UPDATE_RECONNECT_LIMIT_MS = 30 * 1000;

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

export function updatePresentation(status: WebUpdateStatus | undefined, view: UpdateViewState, transportError?: string): UpdatePresentation {
  if (view === "starting") return "updating";
  if (view === "reconnecting") return "reconnecting";
  if (view === "recovery-needed") return "recovery-needed";
  if (status?.operation?.state === "updating") return "updating";
  if (status?.operation?.state === "succeeded") return "success";
  if (status?.operation?.state === "failed") return "failure";
  if (status?.operation?.state === "unverified") return "recovery-needed";
  if (view === "checking") return "checking";
  if (transportError || status?.checkError) return "error";
  if (status?.eligibility.state === "unsupported") return "unsupported";
  if (status?.eligibility.state === "blocked") return "blocked";
  return status?.updateAvailable ? "available" : "up-to-date";
}
