import type { DockLayout, DockSide } from "./docks.ts";

/** A nested, full-area destination inside one mobile Dock tab. */
export type MobileDetail =
  | { kind: "subagent"; id: string }
  | { kind: "workflow-step"; id: string };

/** The one Agent Session surface occupying the mobile content area. */
export type MobileView =
  | { kind: "transcript" }
  | { kind: "dock"; side: DockSide; tabId: string; detail?: MobileDetail };

export const MOBILE_TRANSCRIPT: MobileView = { kind: "transcript" };

const STATE_KEY = "flowMobileView";

type StoredMobileView = {
  sessionId: string;
  view: MobileView;
};

/** Read only history written for this Agent Session. Other entries safely mean Transcript. */
export function mobileViewFromHistory(state: unknown, sessionId: string): MobileView {
  if (!record(state)) return MOBILE_TRANSCRIPT;
  const stored = state[STATE_KEY];
  if (!record(stored) || stored.sessionId !== sessionId) return MOBILE_TRANSCRIPT;
  return parseMobileView(stored.view) ?? MOBILE_TRANSCRIPT;
}

/** Merge with rather than replace another feature's history state. */
export function historyWithMobileView(state: unknown, sessionId: string, view: MobileView): object {
  return {
    ...(record(state) ? state : {}),
    [STATE_KEY]: { sessionId, view } satisfies StoredMobileView,
  };
}

/** Closed or malformed tab targets never recreate content; they fall back to Transcript. */
export function validMobileView(view: MobileView, layout: DockLayout): MobileView {
  if (view.kind === "transcript") return view;
  return layout[view.side].tabs.some((tab) => tab.id === view.tabId) ? view : MOBILE_TRANSCRIPT;
}

export function sameMobileView(left: MobileView, right: MobileView): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "transcript" || right.kind === "transcript") return true;
  return left.side === right.side && left.tabId === right.tabId && sameDetail(left.detail, right.detail);
}

function sameDetail(left: MobileDetail | undefined, right: MobileDetail | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.kind === right.kind && left.id === right.id;
}

function parseMobileView(value: unknown): MobileView | undefined {
  if (!record(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "transcript") return MOBILE_TRANSCRIPT;
  if (
    value.kind !== "dock" ||
    (value.side !== "bottom" && value.side !== "right") ||
    typeof value.tabId !== "string" ||
    value.tabId === ""
  ) return undefined;

  const detail = parseDetail(value.detail);
  return {
    kind: "dock",
    side: value.side,
    tabId: value.tabId,
    ...(detail === undefined ? {} : { detail }),
  };
}

function parseDetail(value: unknown): MobileDetail | undefined {
  if (!record(value) || typeof value.id !== "string" || value.id === "") return undefined;
  return value.kind === "subagent" || value.kind === "workflow-step"
    ? { kind: value.kind, id: value.id }
    : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
