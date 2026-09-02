/**
 * Deep links, as string transformations.
 *
 * `#/s/<id>` names the Agent Session on screen and `#/settings/<section>` names a section of the
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
 * out of them and a section can be linked to. They are *not* nested under an Agent Session, because
 * they are machine-wide (src/protocol/settings.ts): a URL implying otherwise would be a lie about
 * their scope.
 */

/** The sections of the Settings, in the order the rail lists them. */
export const SETTINGS_SECTIONS = ["general", "appearance", "keyboard"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  /** The Agent Session view. `sessionId` is undefined when the URL names none. */
  | { view: "session"; sessionId: string | undefined }
  | { view: "settings"; section: SettingsSection };

/** What an app with a clean URL is looking at. */
export const DEFAULT_ROUTE: Route = { view: "session", sessionId: undefined };

export function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((part) => part !== "");

  if (parts[0] === "settings") {
    // An unknown section lands on the first one rather than on nothing. Sections get renamed and
    // bookmarks do not, and "the Settings, at the top" is always a useful answer.
    return { view: "settings", section: asSection(parts[1]) ?? SETTINGS_SECTIONS[0] };
  }

  if (parts[0] !== "s" || parts[1] === undefined) return DEFAULT_ROUTE;

  const sessionId = decode(parts[1]);
  // Whatever follows the id is ignored rather than treated as unparseable. A bookmark may carry
  // trailing segments this app no longer writes, and opening the Agent Session it names first is
  // more use to its reader than opening nothing at all.
  return { view: "session", sessionId: sessionId === "" ? undefined : sessionId };
}

export function formatRoute(route: Route): string {
  if (route.view === "settings") return `#/settings/${route.section}`;
  return route.sessionId === undefined ? "" : `#/s/${encodeURIComponent(route.sessionId)}`;
}

/** The Agent Session a route names, if it names one. Saves every caller a `view` check. */
export function routedSessionId(route: Route): string | undefined {
  return route.view === "session" ? route.sessionId : undefined;
}

function asSection(part: string | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section === decode(part ?? ""));
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A hand-edited hash with a stray `%` is not worth a thrown exception on load.
    return "";
  }
}
