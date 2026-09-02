/**
 * A Project, as it crosses the wire.
 *
 * A Project is a *candidate* Scope: a directory a new Agent Session can be started from. It is not
 * a Scope. A Scope is the binding one Agent Session holds for its whole life, whereas a Project
 * exists before any Agent Session, outlives all of them, and may have several bound to it at once.
 * Choosing a Project is how a client sets a Scope (CONTEXT.md).
 *
 * **Projects are opted into, not merely found.** `projects.include` in config.json is the list, and
 * it is the whole of it: a repository beneath the Project Root is a *candidate* until it appears
 * there. Discovery still exists, but it now feeds the Settings page's list of things to opt into
 * rather than the dropdown itself — which is what lets the list stay as short as its owner wants
 * (ADR 0011). A Project need not be a repository at all, because an opted-in directory is chosen
 * deliberately and nothing has to guess whether it was meant.
 *
 * In the protocol rather than beside the walk that produces it because both ends need the shape:
 * the Session Host reports these on /api/config, and the web client renders them as a grouped
 * dropdown. `src/daemon/projects.ts` owns how they are found; this file owns only what they look
 * like.
 */

export type Project = {
  /** Absolute path. This is what becomes the Agent Session's Scope. */
  path: string;
  /** The directory's own name — `"repo-a"`. What the dropdown shows. */
  name: string;
  /**
   * The path from the Project Root down to, but excluding, the Project — `"work"`,
   * `"work/backend"`. Absent for a direct child of the Project Root, and for a Project Root that is
   * itself a repository.
   *
   * A string rather than a nested tree, because one level of headings is what a dropdown can draw:
   * a tree would be flattened for display anyway, at the cost of a recursive type on the wire and a
   * recursive component to render it. Nesting deeper than one level reads as `"work/backend"`.
   */
  group?: string;
  /**
   * Set when an opted-in Project's directory is not there any more.
   *
   * Reported rather than quietly dropped. A list its owner curated by hand is a list they should be
   * told has gone stale — silently omitting a repository they deleted looks identical to the
   * Setting having failed to save, and one of those is worth acting on.
   *
   * Only ever set on an opted-in Project. A candidate was found by looking, so it exists by
   * construction.
   */
  missing?: true;
};

/**
 * What `GET /api/directories?q=…` answers with: absolute directory paths, best first.
 *
 * Two searches behind one endpoint, chosen by the query's first character, because they answer two
 * different questions a person asks. A query starting with `/` or `~` is a *path*, and the answer is
 * completion — the children of the deepest directory that exists, anywhere on the machine. Anything
 * else is a *name*, and the answer is a fuzzy match beneath the Project Root. The rule is the first
 * character rather than "does it contain a slash", so that `work/api` still reads as a name and
 * matches a nested one.
 */
export type DirectoryMatches = {
  /** Echoed back, so a client can discard an answer to a query its reader has moved on from. */
  query: string;
  /** Which of the two searches ran, so the UI can say what it is showing. */
  kind: "completion" | "search";
  paths: string[];
  /** Set when the answer was cut off at the cap, so the UI can say "keep typing" honestly. */
  truncated?: true;
};
