import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
export const OPEN_BROWSER_UPDATE_CHECK_MS = 60 * 60 * 1000;
export const UPDATE_MUTATION_TIMEOUT_MS = 10 * 1000;
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

export function updatePresentation(status: WebUpdateStatus | undefined, view: UpdateViewState, transportError?: string): UpdatePresentation {
  if (view === "starting") return "updating";
  if (view === "reconnecting") return "reconnecting";
  if (view === "recovery-needed") return "recovery-needed";
  if (status?.operation?.state === "updating") return "updating";
  if (status?.operation?.state === "unverified") return "recovery-needed";
  if (view === "checking") return "checking";
  if (transportError || status?.checkError) return "error";

  // A settled operation is history when discovery finds a successive release. Eligibility for that
  // release is the current actionable state, including blockers and unsupported installations.
  if (status?.updateAvailable && status.eligibility.state === "unsupported") return "unsupported";
  if (status?.updateAvailable && status.eligibility.state === "blocked") return "blocked";
  if (status?.operation?.state === "failed") return "failure";
  if (status?.eligibility.state === "eligible" && status.updateAvailable) return "available";
  if (status?.operation?.state === "succeeded") return "success";
  if (status?.eligibility.state === "unsupported") return "unsupported";
  if (status?.eligibility.state === "blocked") return "blocked";
  return status?.updateAvailable ? "available" : "up-to-date";
}

export function updateDetail(
  presentation: UpdatePresentation,
  status: WebUpdateStatus | undefined,
  errors: { actionError?: string; transportError?: string } = {},
): string {
  const historical = historicalOutcome(status);
  switch (presentation) {
    case "checking": return "Checking the npm registry for the latest stable release…";
    case "up-to-date": return `Flow ${status?.installedVersion ?? ""} is up to date.`;
    case "available": return `Flow ${status?.latestVersion} is available and this installation can update safely.`;
    case "unsupported": return appendHistorical(
      status?.eligibility.state === "unsupported" ? status.eligibility.reason : "This installation cannot update itself.",
      historical,
    );
    case "blocked": return appendHistorical(
      status?.eligibility.state === "blocked" ? status.eligibility.reason : "Active work must finish before Flow can update.",
      historical,
    );
    case "updating": return "The guarded npm update is running independently of this browser. The Session Host will restart shortly.";
    case "reconnecting": return "The Session Host is restarting. Flow will reconnect and verify the running version automatically.";
    case "success": return `${status?.operation?.message ?? "The update was verified."} Updated web assets are loaded; Agent Sessions remain Dormant until you Revive them.`;
    case "failure": return `${status?.operation?.message ?? "The update failed."} The Session Host recovered, but this remains a failed update.`;
    case "recovery-needed": {
      const lastKnown = status?.operation?.message ? ` Last known update status: ${status.operation.message}` : "";
      return `Flow could not verify recovery. Reconnect below; if the host remains unavailable, repair the private global npm installation manually and restart it.${lastKnown}`;
    }
    case "error": return errors.actionError ?? status?.checkError ?? errors.transportError ?? "Could not check for updates. Normal Flow use is unaffected.";
  }
}

export function canStartUpdate(status: WebUpdateStatus | undefined, presentation: UpdatePresentation): boolean {
  return status?.eligibility.state === "eligible" && status.updateAvailable && status.latestVersion !== undefined && ["available", "failure"].includes(presentation);
}

function historicalOutcome(status: WebUpdateStatus | undefined): string | undefined {
  const operation = status?.operation;
  if (operation?.state === "succeeded") {
    const version = operation.installedVersion ?? operation.targetVersion;
    return `The previous update${version ? ` to Flow ${version}` : ""} was verified successfully.`;
  }
  if (operation?.state === "failed") return `The previous update failed${operation.message ? `: ${operation.message}` : "."}`;
  return undefined;
}

function appendHistorical(detail: string, historical: string | undefined): string {
  return historical ? `${detail} ${historical}` : detail;
}
