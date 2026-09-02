import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { DirectoryMatches, Project } from "../protocol/projects.ts";

/**
 * Finding directories: the Projects that are opted in, the repositories worth suggesting, and the
 * two searches that help someone opt in.
 *
 * **`projects.include` is the Projects list.** `includedProjects` resolves it, and nothing else
 * here produces a Project a client will offer. Everything else exists to make that list easy to
 * write (ADR 0011).
 *
 * `discoverProjects` supplies *candidates*: a directory holding a `.git` beneath the Project Root,
 * with the folders above it as a heading. A repository is a **leaf** — recorded, never looked
 * inside — which prunes `node_modules` and build output without a name blacklist. Its cost is that
 * a monorepo suggests only itself, and `searchDirectories` is the answer to that: it deliberately
 * does *not* stop at repositories, so `<root>/monorepo/packages/api` can be found and opted in.
 * That is the one place a blacklist is unavoidable, and `NEVER_OFFERED` is it.
 *
 * Nothing here throws, and nothing follows a symlink. A directory that is absent or unreadable
 * contributes nothing: a mistyped Project Root yields no candidates, which the Settings page reports
 * as a count — more use to its reader than an error on a save they already committed to.
 */

/** How far below the Project Root a Project may sit. `<root>/kind/team/repo` is the deepest. */
export const MAX_DEPTH = 3;

/**
 * How many directories one walk may look at.
 *
 * A backstop against a Project Root of `/`, which `MAX_DEPTH` alone does not bound usefully — three
 * levels below the filesystem root is tens of thousands of directories. This is what makes the
 * synchronous `fs` below safe rather than merely conventional: the walk runs inside a request
 * handler, so its cost has to be bounded by something other than good intentions.
 */
export const MAX_VISITS = 2000;

/**
 * `~/workspace` as an absolute path.
 *
 * The Project Root is stored and reported as the string a person typed — the same round trip a
 * duration makes (src/protocol/settings.ts) — so the tilde survives into config.json and back into
 * the Settings page, and is resolved only here, at the point of use.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Every Project beneath `root`, sorted by group and then by name.
 *
 * Sorted because `readdirSync` order is not guaranteed, and a dropdown that reshuffles between page
 * loads is a bug rather than a cosmetic complaint.
 */
export function discoverProjects(root: string | undefined): Project[] {
  if (root === undefined) return [];
  const absolute = expandHome(root);
  if (!isAbsolute(absolute)) return [];
  if (!isDirectory(absolute)) return [];

  const found: Project[] = [];
  // A budget rather than a counter per level: the pathological tree is wide, not deep.
  const budget = { left: MAX_VISITS };

  // A Project Root that is itself a repository is the one Project it offers. Without this, pointing
  // the root at a single checkout reports nothing at all — every repository beneath it is inside
  // it, and so is never visited.
  if (isRepository(absolute)) {
    return [{ path: absolute, name: basename(absolute) }];
  }

  descend(absolute, undefined, 1, found, budget);

  return found.sort(
    (left, right) =>
      (left.group ?? "").localeCompare(right.group ?? "") || left.name.localeCompare(right.name),
  );
}

function descend(
  directory: string,
  group: string | undefined,
  depth: number,
  found: Project[],
  budget: { left: number },
): void {
  if (depth > MAX_DEPTH || budget.left <= 0) return;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // Unreadable — a directory this user cannot enter is not an error worth failing a page load
    // over, and there is nothing useful to say about it.
    return;
  }

  for (const entry of entries) {
    if (budget.left <= 0) return;
    // `isDirectory()` is false for a symlink, which is how a symlink loop is refused: following one
    // is the only way this walk could fail to terminate.
    if (!entry.isDirectory()) continue;
    // A dotted directory is infrastructure, not a Project — `.git`, `.cache`, `.config`.
    if (entry.name.startsWith(".")) continue;

    budget.left -= 1;
    const path = join(directory, entry.name);

    if (isRepository(path)) {
      found.push({ path, name: entry.name, ...(group === undefined ? {} : { group }) });
      // Deliberately not descending. See the header: this is the whole pruning rule.
      continue;
    }

    descend(path, group === undefined ? entry.name : `${group}/${entry.name}`, depth + 1, found, budget);
  }
}

/**
 * Whether a directory is a repository.
 *
 * `.git` is tested as a path that *exists*, not as a directory: in a linked worktree or a submodule
 * it is a file containing a `gitdir:` pointer, and treating those as non-repositories would descend
 * into them and offer their subdirectories as Projects.
 */
function isRepository(directory: string): boolean {
  return statSync(join(directory, ".git"), { throwIfNoEntry: false }) !== undefined;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** The last segment, without pulling in `node:path`'s trailing-slash behaviour. */
function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? path;
}

/**
 * The opted-in Projects, in the order they were configured.
 *
 * Configured order, deliberately not sorted: this list was curated by hand, so its order is a
 * decision someone made and re-alphabetising it would overrule them. That is the opposite of
 * `discoverProjects`, which sorts because `readdirSync` order is arbitrary and nobody chose it.
 *
 * An entry may be relative or absolute. Relative resolves against the Project Root, which is what
 * makes a hand-written `["work/api", "e2e"]` read well and survive the root being moved; absolute
 * is how a Project outside the root is named at all. A missing directory is reported rather than
 * dropped — see `Project.missing`.
 */
export function includedProjects(root: string | undefined, include: readonly string[]): Project[] {
  const base = root === undefined ? undefined : expandHome(root);
  const seen = new Set<string>();
  const projects: Project[] = [];

  for (const entry of include) {
    const path = resolveEntry(base, entry);
    // A duplicate is a no-op rather than a second row. The Settings page will not create one, but a
    // hand-edited file can, and two identical rows in a dropdown is not a useful thing to render.
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    projects.push({
      path,
      name: basename(path),
      ...groupOf(base, path),
      ...(isDirectory(path) ? {} : { missing: true as const }),
    });
  }
  return projects;
}

/** An entry as an absolute path, or undefined if it cannot be made into one. */
function resolveEntry(base: string | undefined, entry: string): string | undefined {
  const trimmed = entry.trim();
  if (trimmed === "") return undefined;
  const expanded = expandHome(trimmed);
  if (isAbsolute(expanded)) return normalisePath(expanded);
  // Relative, so it needs a root to be relative *to*. Without one it names nothing.
  if (base === undefined) return undefined;
  return normalisePath(join(base, expanded));
}

/**
 * The heading an opted-in Project sits under: the folders between the Project Root and it.
 *
 * Derived from the path rather than stored, so it agrees with what `discoverProjects` produces for
 * the same directory. A Project outside the root gets none — there is nothing to be relative to,
 * and inventing "elsewhere" would name a folder nobody made.
 */
function groupOf(base: string | undefined, path: string): { group?: string } {
  if (base === undefined) return {};
  const prefix = `${normalisePath(base)}/`;
  if (!path.startsWith(prefix)) return {};
  const segments = path.slice(prefix.length).split("/");
  segments.pop();
  return segments.length === 0 ? {} : { group: segments.join("/") };
}

/** Trailing slashes and `.` segments removed, so two spellings of one directory compare equal. */
function normalisePath(path: string): string {
  const cleaned = path.replace(/\/+$/, "").replace(/\/\.(?=\/|$)/g, "");
  return cleaned === "" ? "/" : cleaned;
}

/**
 * How many matches one search answers with before it says "keep typing".
 *
 * A cap rather than a page: this feeds a dropdown someone is typing into, and the answer to "too
 * many matches" is a narrower query, not a second request.
 */
export const MAX_MATCHES = 40;

/**
 * How deep a *search* goes, as opposed to a Project walk.
 *
 * Deeper than `MAX_DEPTH` because this one does not stop at repositories, and the directory most
 * worth finding this way is the one a Project walk refuses to offer — `monorepo/packages/api`,
 * which is already three levels down before the interesting part.
 */
export const MAX_SEARCH_DEPTH = 5;

/**
 * Directory names never worth offering, and the reason this list has to exist at all.
 *
 * `discoverProjects` needs no blacklist because stopping at a repository prunes everything inside
 * it. A search deliberately does not stop there — reaching inside a monorepo is the point — so the
 * pruning has to be done by name after all. Kept deliberately short: these are the directories that
 * are *machine* output in every ecosystem, not merely uninteresting ones.
 */
const NEVER_OFFERED = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
]);

/**
 * Directories matching `query`, as either a completion or a search.
 *
 * The first character decides which (see `DirectoryMatches`): `/` or `~` means the reader is typing
 * a path and wants its siblings; anything else means they are naming a directory and want it found.
 * A completion reaches the whole machine, which is not a privilege escalation — ADR 0004 already
 * has it that anything able to reach this daemon can run commands as its user — but it is a
 * filesystem the caller can enumerate, so it is worth saying out loud.
 */
export function searchDirectories(root: string | undefined, query: string): DirectoryMatches {
  const trimmed = query.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return complete(trimmed);
  }
  return search(root, trimmed);
}

/**
 * Path completion: the child directories of the deepest ancestor that exists.
 *
 * One `readdirSync` and no walking at all, which is what makes reaching the whole machine cheap
 * enough to do on a keystroke. `/home/node/wo` lists `/home/node`'s children beginning "wo";
 * `/home/node/` lists all of them.
 */
function complete(query: string): DirectoryMatches {
  const expanded = expandHome(query);
  const cut = expanded.lastIndexOf("/");
  // No slash cannot happen — the caller only routes here for a leading `/` or `~`, and `~` expands
  // to an absolute path — but the parent has to come from somewhere, so this is not left implicit.
  const parent = cut <= 0 ? "/" : expanded.slice(0, cut);
  const fragment = expanded.slice(cut + 1).toLowerCase();

  const names = childDirectories(parent)
    .filter((name) => name.toLowerCase().startsWith(fragment))
    .sort((left, right) => left.localeCompare(right));

  return {
    query,
    kind: "completion",
    paths: names.slice(0, MAX_MATCHES).map((name) => join(parent, name)),
    ...(names.length > MAX_MATCHES ? { truncated: true as const } : {}),
  };
}

/**
 * Fuzzy search beneath the Project Root, repositories included rather than stopped at.
 *
 * What a query is matched against depends on whether it contains a slash, because the two spellings
 * mean different things. `api` is a *name*, and matching it against the relative path would drag in
 * every descendant of a hit — `work/api/packages` contains "api" only by inheritance, which is
 * noise. `work/api` is a *subtree*, and there matching the whole relative path is exactly right,
 * descendants included.
 *
 * Ranked shallowest-first: a directory nearer the root is more likely to be the one meant, and depth
 * is the only signal available that does not require guessing at intent.
 */
function search(root: string | undefined, query: string): DirectoryMatches {
  if (root === undefined || query === "") return { query, kind: "search", paths: [] };
  const base = expandHome(root);
  if (!isAbsolute(base) || !isDirectory(base)) return { query, kind: "search", paths: [] };

  const needle = query.toLowerCase();
  // A slash makes the query a subtree rather than a name — see the note above.
  const againstPath = needle.includes("/");
  const matches: { path: string; depth: number }[] = [];
  const budget = { left: MAX_VISITS };

  const walk = (directory: string, relative: string, depth: number): void => {
    if (depth > MAX_SEARCH_DEPTH || budget.left <= 0) return;
    for (const name of childDirectories(directory)) {
      if (budget.left <= 0) return;
      if (name.startsWith(".") || NEVER_OFFERED.has(name)) continue;
      budget.left -= 1;

      const path = join(directory, name);
      const nextRelative = relative === "" ? name : `${relative}/${name}`;
      const against = againstPath ? nextRelative : name;
      if (against.toLowerCase().includes(needle)) matches.push({ path, depth });
      walk(path, nextRelative, depth + 1);
    }
  };
  walk(base, "", 1);

  matches.sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));
  return {
    query,
    kind: "search",
    paths: matches.slice(0, MAX_MATCHES).map((match) => match.path),
    ...(matches.length > MAX_MATCHES ? { truncated: true as const } : {}),
  };
}

/** The directory names directly inside `path`. Unreadable or absent contributes nothing. */
function childDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
