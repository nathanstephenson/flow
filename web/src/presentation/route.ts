/**
 * Deep links, as string transformations.
 *
 * `#/s/<id>` names the Agent Session on screen and `?settings=<section>` names the open section of the
 * Settings, parsed and formatted by hand. No router: a router costs a second source of truth for a
 * selection the app shell already owns, and — decisively — real paths would need the Session Host's
 * SPA fallback to be right about every URL anyone might bookmark, whereas a fragment is never sent
 * to the server at all.
 *
 * It lives here, DOM-free, so `node --test` can hold it to account. Reading `location.hash` and
 * writing it back is the caller's business; deciding what a hash *means* is this file's, and that is
 * the half with the edge cases in it.
 *
 * Settings are routed rather than held in a component's state so that reloading does not throw you
 * out of them and a section can be linked to. They are a Dialog over the Agent Session view, so the
 * section is a query beside the session path. The old `#/settings/<section>` hash still opens them.
 */

/** The sections of the Settings, in the order the rail lists them. */
export const SETTINGS_SECTIONS = [
  "general",
  "projects",
  "permissions",
  "providers",
  "appearance",
  "keyboard",
  "workflows",
  "secrets",
  "mcp",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route = {
  /** Undefined when the URL names no Agent Session. */
  sessionId: string | undefined;
  backend?: string;
  /** The open section of the Settings Dialog. Undefined when the Dialog is closed. */
  settings?: SettingsSection;
};

/** What an app with a clean URL is looking at. */
export const DEFAULT_ROUTE: Route = { sessionId: undefined };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  const parts = path.split("/").filter((part) => part !== "");

  if (parts[0] === "settings") return { sessionId: undefined, settings: asSection(parts[1]) };

  const route = sessionPart(parts);
  const section = new URLSearchParams(query).get("settings");
  return section === null ? route : { ...route, settings: asSection(section) };
}

function sessionPart(parts: string[]): Route {
  if (parts[0] === "new" && parts[1]) return { sessionId: undefined, backend: decode(parts[1]) };
  if (parts[0] !== "s" || parts[1] === undefined) return DEFAULT_ROUTE;

  const sessionId = decode(parts[1]);
  // Whatever follows the id is ignored rather than treated as unparseable. A bookmark may carry
  // trailing segments this app no longer writes, and opening the Agent Session it names first is
  // more use to its reader than opening nothing at all.
  return { sessionId: sessionId === "" ? undefined : sessionId };
}

export function formatRoute(route: Route): string {
  const path =
    route.sessionId !== undefined
      ? `#/s/${encodeURIComponent(route.sessionId)}`
      : route.backend
        ? `#/new/${encodeURIComponent(route.backend)}`
        : "";
  if (route.settings === undefined) return path;
  return `${path || "#/"}?settings=${route.settings}`;
}

// An unknown section lands on the first one rather than on nothing. Sections get renamed and
// bookmarks do not, and "the Settings, at the top" is always a useful answer.
function asSection(part: string | undefined): SettingsSection {
  return SETTINGS_SECTIONS.find((section) => section === decode(part ?? "")) ?? SETTINGS_SECTIONS[0];
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A hand-edited hash with a stray `%` is not worth a thrown exception on load.
    return "";
  }
}
