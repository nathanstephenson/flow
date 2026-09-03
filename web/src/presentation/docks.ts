/**
 * The two Docks, as data.
 *
 * A Dock is a region of the Agent Session's pane — one below the transcript, one beside it — holding
 * tabs. It is chrome rather than domain language, which is why it is not in CONTEXT.md and why the
 * rail is not either: where a Shell is drawn is not what a Shell is.
 *
 * Its own module, DOM-free and under test, for the same reason `rail-width.ts` is: the interesting
 * part of a tabbed splitter is not the pointer events, it is what happens to the *rest* of the tabs
 * when one closes, what a size clamped against a container that has not been measured yet does, and
 * what to do with a layout written by a different build. All three are easy to get subtly wrong and
 * invisible when you do.
 *
 * Two states only, Open and Minimised. There is deliberately no third "empty" state: an open Dock
 * with no tabs shows the content picker filling its body, so the picker is simply the body of a tab
 * whose kind has not been chosen. `addTab` adds one of those, and closing the last tab drops back to
 * it rather than collapsing the Dock out from under the button that just opened it.
 */

export type DockSide = "bottom" | "right";

/**
 * What is in a tab. `shellId` is absent between the tab being filled and the Shell being opened —
 * `openShell` needs the terminal's measured size, so the id arrives one paint later.
 */
export type DockTabContent = { kind: "shell"; shellId?: string };

/** `content: undefined` is an unchosen tab, and unchosen is what draws the picker. */
export type DockTab = { id: string; content: DockTabContent | undefined };

export type Dock = {
  tabs: DockTab[];
  activeId: string | undefined;
  /** Height for the bottom Dock, width for the right one, in px. */
  size: number;
  minimised: boolean;
};

export type DockLayout = { bottom: Dock; right: Dock };

/**
 * How big a Dock is by default, and how small it may be dragged.
 *
 * `RESERVE` is what the conversation keeps whatever the drag does. A maximum expressed in pixels
 * cannot work here — a Dock's ceiling is a share of the pane, and the pane is a different size on
 * every screen — so the clamp takes the container's extent and reserves from it instead.
 */
const DEFAULT_SIZE: Record<DockSide, number> = { bottom: 300, right: 380 };
const MIN_SIZE: Record<DockSide, number> = { bottom: 120, right: 240 };
const RESERVE: Record<DockSide, number> = { bottom: 200, right: 320 };

/** How far one arrow key moves a Dock's splitter, matching the rail's steps. */
export function dockSizeStep(shiftKey: boolean): number {
  return shiftKey ? 64 : 16;
}

export function clampDockSize(side: DockSide, px: number, available?: number): number {
  const min = MIN_SIZE[side];
  if (!Number.isFinite(px)) return DEFAULT_SIZE[side];
  // An unmeasured container only floors the value. Clamping to a maximum derived from zero would
  // pin every Dock to its minimum for the one frame before the pane has a size.
  const max =
    available === undefined || !Number.isFinite(available) || available <= 0
      ? Number.POSITIVE_INFINITY
      : Math.max(min, available - RESERVE[side]);
  return Math.round(Math.min(Math.max(px, min), max));
}

export function emptyDock(side: DockSide): Dock {
  return { tabs: [], activeId: undefined, size: DEFAULT_SIZE[side], minimised: true };
}

export function defaultLayout(): DockLayout {
  return { bottom: emptyDock("bottom"), right: emptyDock("right") };
}

export function addTab(dock: Dock, tabId: string): Dock {
  return { ...dock, tabs: [...dock.tabs, { id: tabId, content: undefined }], activeId: tabId };
}

/**
 * Put a Shell in a tab, adding the tab if it is not there yet.
 *
 * One function for both ways the picker is reached: filling the unchosen tab `+` just made, and
 * choosing from the picker a Dock shows when it holds nothing at all. `shellId` is absent because
 * `openShell` needs the terminal's measured size — the tab's body opens the Shell one paint later
 * and reports the id back through `rememberShell`.
 */
export function fillWithShell(dock: Dock, tabId: string): Dock {
  const known = dock.tabs.some((tab) => tab.id === tabId);
  const content: DockTabContent = { kind: "shell" };
  return {
    ...dock,
    tabs: known
      ? dock.tabs.map((tab) => (tab.id === tabId ? { ...tab, content } : tab))
      : [...dock.tabs, { id: tabId, content }],
    activeId: tabId,
  };
}

/** The Shell has been opened and has an id. A tab that closed while it opened is left alone. */
export function rememberShell(dock: Dock, tabId: string, shellId: string): Dock {
  return {
    ...dock,
    tabs: dock.tabs.map((tab) => (tab.id === tabId ? { ...tab, content: { kind: "shell", shellId } } : tab)),
  };
}

/**
 * Close a tab, and say which Shell went with it.
 *
 * The caller kills that Shell: a tab is a Shell's only handle, so closing the tab is ending the
 * Shell (ADR 0008). Returning the id rather than killing it here keeps this module free of fetch.
 *
 * The active tab moves left, because that is where the eye already is — and to the right only when
 * the tab that closed was the first.
 */
export function closeTab(dock: Dock, tabId: string): { dock: Dock; killed: string | undefined } {
  const index = dock.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return { dock, killed: undefined };

  const tabs = dock.tabs.filter((tab) => tab.id !== tabId);
  const neighbour = tabs[Math.max(0, index - 1)];
  const closed = dock.tabs[index];
  return {
    dock: {
      ...dock,
      tabs,
      activeId: dock.activeId === tabId ? neighbour?.id : dock.activeId,
    },
    killed: closed?.content?.shellId,
  };
}

export function setActive(dock: Dock, tabId: string): Dock {
  return dock.tabs.some((tab) => tab.id === tabId) ? { ...dock, activeId: tabId } : dock;
}

export function setSize(side: DockSide, dock: Dock, px: number, available?: number): Dock {
  return { ...dock, size: clampDockSize(side, px, available) };
}

/**
 * Show or hide the Dock, remembering everything either way.
 *
 * Minimising closes the sockets and leaves the ptys running, which is the one place the old close
 * button's promise survives: hiding a Shell does not end it. There is nothing else to decide here —
 * a Dock opened with no tabs shows the picker in its body, so "open" and "has something in it" are
 * separate questions and only one of them is this one.
 */
export function toggleMinimised(dock: Dock): Dock {
  return { ...dock, minimised: !dock.minimised };
}

/**
 * Reconcile a stored layout against the Shells the Session Host actually has.
 *
 * Shells are ephemeral (CONTEXT.md) — they do not survive a daemon restart, and Settling, Ending or
 * Reaping an Agent Session kills them — so every stored id is a corpse until proven otherwise. Rather
 * than persist tombstones or derive the tabs from the host outright, which could not represent an
 * unchosen tab, the stored order is kept and checked: dead tabs go, and live Shells nothing claims
 * are adopted so that a Shell opened in another browser window is not invisible here.
 *
 * Both Docks at once, deliberately. Reconciling them one at a time would adopt each unclaimed Shell
 * twice — once per Dock — and two tabs onto one pty means closing either kills the other's Shell.
 * Adoptions land in the bottom Dock because that is where a terminal goes unless someone moved it.
 *
 * Runs on arrival at an Agent Session and nowhere else. A Shell that exits while being watched keeps
 * its tab and its last screen — that output is usually the reason it was being watched — and a
 * reconcile on exit would sweep it away at exactly the wrong moment.
 */
export function reconcileLayout(layout: DockLayout, liveShellIds: readonly string[]): DockLayout {
  const live = new Set(liveShellIds);
  const bottom = dropDead(layout.bottom, live);
  const right = dropDead(layout.right, live);

  const claimed = new Set([...claims(bottom), ...claims(right)]);
  const adopted: DockTab[] = liveShellIds
    .filter((shellId) => !claimed.has(shellId))
    .map((shellId) => ({ id: `shell-${shellId}`, content: { kind: "shell", shellId } }));

  return { bottom: settleActive({ ...bottom, tabs: [...bottom.tabs, ...adopted] }), right: settleActive(right) };
}

function dropDead(dock: Dock, live: ReadonlySet<string>): Dock {
  return {
    ...dock,
    tabs: dock.tabs.filter((tab) => {
      const shellId = tab.content?.shellId;
      // Unchosen tabs, and tabs whose Shell is still being opened, claim nothing yet and survive.
      return shellId === undefined || live.has(shellId);
    }),
  };
}

function claims(dock: Dock): string[] {
  return dock.tabs.map((tab) => tab.content?.shellId).filter((id): id is string => id !== undefined);
}

/** After tabs have come and gone, the active one has to be a tab that is still there. */
function settleActive(dock: Dock): Dock {
  const activeId = dock.tabs.some((tab) => tab.id === dock.activeId) ? dock.activeId : dock.tabs[0]?.id;
  return { ...dock, activeId };
}

/**
 * What a tab calls itself.
 *
 * Numbered by position among the Shells rather than by a stored label, so closing the first of three
 * leaves "Shell 1" and "Shell 2" rather than a gap. The number is an ordinal in this Dock, not a
 * Shell id: two Docks each have a Shell 1, which is honest, because what a reader means by "the
 * other shell" is the other tab.
 */
export function tabLabel(dock: Dock, tabId: string): string {
  let ordinal = 0;
  for (const tab of dock.tabs) {
    if (tab.content?.kind === "shell") ordinal += 1;
    if (tab.id === tabId) return tab.content === undefined ? "New tab" : `Shell ${ordinal}`;
  }
  return "New tab";
}

/**
 * Layouts read back from storage, per Agent Session.
 *
 * Lenient to the point of indifference, like `parseRailWidth`: a layout is a remembered convenience,
 * so the worst outcome of a blob written by another build — or edited by hand — must be an Agent
 * Session whose Docks are minimised, never a crash on load.
 */
export function parseLayouts(stored: string | null): Record<string, DockLayout> {
  if (stored === null || stored.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const layouts: Record<string, DockLayout> = {};
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    layouts[sessionId] = parseLayout(value);
  }
  return layouts;
}

function parseLayout(value: unknown): DockLayout {
  if (typeof value !== "object" || value === null) return defaultLayout();
  const record = value as Record<string, unknown>;
  return { bottom: parseDock("bottom", record.bottom), right: parseDock("right", record.right) };
}

function parseDock(side: DockSide, value: unknown): Dock {
  if (typeof value !== "object" || value === null) return emptyDock(side);
  const record = value as Record<string, unknown>;

  const tabs = Array.isArray(record.tabs) ? record.tabs.map(parseTab).filter(isTab) : [];
  const activeId = tabs.some((tab) => tab.id === record.activeId) ? (record.activeId as string) : tabs[0]?.id;
  return {
    tabs,
    activeId,
    size: clampDockSize(side, typeof record.size === "number" ? record.size : Number.NaN),
    // Only an explicit `false` opens a Dock. Anything else — missing, a string, a number — is the
    // quieter answer, and the quieter answer is the right default for a value nobody wrote.
    minimised: record.minimised !== false,
    };
}

function parseTab(value: unknown): DockTab | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return undefined;

  const content = record.content;
  if (typeof content !== "object" || content === null) return { id: record.id, content: undefined };
  const shape = content as Record<string, unknown>;
  if (shape.kind !== "shell") return { id: record.id, content: undefined };
  return {
    id: record.id,
    content: typeof shape.shellId === "string" ? { kind: "shell", shellId: shape.shellId } : { kind: "shell" },
  };
}

function isTab(tab: DockTab | undefined): tab is DockTab {
  return tab !== undefined;
}

/**
 * Forget the Agent Sessions that are gone.
 *
 * Reaping deletes a Settled Agent Session server-side without telling any browser about it, so
 * without this the blob grows by one layout for every Agent Session ever opened and never shrinks.
 */
export function pruneLayouts(
  layouts: Record<string, DockLayout>,
  knownSessionIds: readonly string[],
): Record<string, DockLayout> {
  const known = new Set(knownSessionIds);
  const kept = Object.entries(layouts).filter(([sessionId]) => known.has(sessionId));
  return kept.length === Object.keys(layouts).length ? layouts : Object.fromEntries(kept);
}
