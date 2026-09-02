/**
 * Deep links, as string transformations.
 *
 * `#/s/<id>` names the Agent Session on screen, parsed and formatted by hand. No router: a router
 * costs a second source of truth for a selection the app shell already owns, and — decisively — real
 * paths would need the Session Host's SPA fallback to be right about every URL anyone might bookmark,
 * whereas a fragment is never sent to the server at all.
 *
 * It lives here, DOM-free, so `node --test` can hold it to account. Reading `location.hash` and
 * writing it back is the caller's business; deciding what a hash *means* is this file's, and that is
 * the half with the edge cases in it.
 */

/** The Agent Session a hash names, or `undefined` if it names none. */
export function parseAgentSessionHash(hash: string): string | undefined {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((part) => part !== "");
  if (parts[0] !== "s" || parts[1] === undefined) return undefined;

  const sessionId = decode(parts[1]);
  // Whatever follows the id is ignored rather than treated as unparseable. A bookmark may carry
  // trailing segments this app no longer writes, and opening the Agent Session it names first is
  // more use to its reader than opening nothing at all.
  return sessionId === "" ? undefined : sessionId;
}

export function formatAgentSessionHash(sessionId: string | undefined): string {
  return sessionId === undefined ? "" : `#/s/${encodeURIComponent(sessionId)}`;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A hand-edited hash with a stray `%` is not worth a thrown exception on load.
    return "";
  }
}
