import type { DirectoryMatches } from "../../../src/protocol/projects.ts";

/**
 * What kind of answer a query is going to get, decided without asking the Session Host.
 *
 * The host decides this too — it has to, since it is the one running the search — but the UI needs
 * the same answer one keystroke earlier, to label the field before the reply lands. So the rule
 * lives here as well, and `directory-search.test.ts` states it in the same terms as
 * `searchDirectories` in src/daemon/projects.ts. Two copies of a one-line rule, held together by a
 * test, rather than a spinner that cannot say what it is waiting for.
 */
export function searchKind(query: string): DirectoryMatches["kind"] {
  const trimmed = query.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~") ? "completion" : "search";
}

/**
 * Whether a query is worth sending at all.
 *
 * An empty query has no answer in either mode. A bare `/` or `~` does — the children of the root or
 * of home — so length alone is not the test.
 */
export function worthSearching(query: string): boolean {
  const trimmed = query.trim();
  return trimmed !== "";
}
