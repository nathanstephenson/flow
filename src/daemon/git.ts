import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { Branch } from "../protocol/git.ts";

/**
 * The one place Flow runs git.
 *
 * Every invocation goes through `run`, so the environment, the timeout and the shape of a failure
 * are decided once. Nothing here throws: git is a foreign program, and whether it agreed is data
 * rather than an exception — the same manner `src/daemon/projects.ts` keeps, and load-bearing at
 * the reap site, which must not be able to blow up a timer.
 *
 * **Asked asynchronously, deliberately.** `projects.ts` earns its synchronous `fs` on an explicit
 * bound — a visit budget — and says so: without it, "async would be the only honest choice". No
 * such bound is available here. `git switch` and `git worktree add` run the reader's own
 * `post-checkout` hooks (LFS smudge filters, `npm ci`, code generation) and `worktree add` writes a
 * whole working tree besides. Blocking the loop would stall every SSE subscription, every Shell
 * frame and every other Agent Session's events at once, and the request path already awaits a slow
 * facility inside a GET (`server.ts`'s `shells.available()`), so there is nothing to preserve by
 * going sync. `isRepository` is the one exception, and the reason is below.
 *
 * git runs as the reader's own shell would run it, minus the prompt. No `--no-verify`, no
 * `GIT_CONFIG_NOSYSTEM`: a reader whose hook installs dependencies wants it to run, and a switch
 * that behaves differently under Flow than under their shell is the bug this would be blamed
 * for.
 */

/** Reads — `rev-parse`, `status`, `for-each-ref`. Bounded by the size of the repository. */
export const GIT_READ_TIMEOUT_MS = 10_000;

/**
 * Writes — `switch`, `worktree add`, `worktree remove`.
 *
 * Generous because the cost is not ours to bound: a `post-checkout` hook may install dependencies,
 * and killing one halfway leaves a working tree in a state nobody asked for. A timeout is here to
 * stop a credential prompt hanging forever, not to discipline someone's hooks.
 */
export const GIT_WRITE_TIMEOUT_MS = 120_000;

/** How many branches `/api/branches` will report before saying it stopped. */
export const MAX_BRANCHES = 500;

/** How many names a derived branch or directory will try before giving up. */
const MAX_CANDIDATES = 50;

const NAMESPACE = "flow/";

export type GitFailure = {
  /** What was attempted, in git's own terms — `switch feature/login`. Not the argv, which carries -C. */
  attempted: string;
  /** git's stderr, trimmed, verbatim. It explains a refused checkout better than we can. */
  message: string;
  /** git's exit status. Absent when git never ran: not installed, or killed on timeout. */
  code?: number;
};

export type GitResult<T> = { ok: true; value: T } | { ok: false; failure: GitFailure };

const exec = promisify(execFile);

function refuse(attempted: string, message: string, code?: number): GitResult<never> {
  return { ok: false, failure: { attempted, message, ...(code === undefined ? {} : { code }) } };
}

/**
 * One git invocation.
 *
 * `-C <dir>` rather than `cwd:`, so a directory that is not there fails as a git error we can
 * report rather than as an ENOENT on spawn, which reads to the caller as a broken daemon.
 *
 * `GIT_TERMINAL_PROMPT=0` because a git that asks for a credential on a daemon with no terminal
 * waits forever, and a refused invocation is strictly better than a hung one. `GIT_OPTIONAL_LOCKS=0`
 * so a read never takes `index.lock` out from under the reader's own terminal.
 */
async function run(
  directory: string | undefined,
  args: string[],
  timeout: number,
): Promise<GitResult<string>> {
  const attempted = args.join(" ");
  try {
    const { stdout } = await exec("git", directory === undefined ? args : ["-C", directory, ...args], {
      timeout,
      maxBuffer: 1 << 20,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return { ok: true, value: stdout };
  } catch (error) {
    const failed = error as { stderr?: string; message?: string; code?: number };
    const said = (failed.stderr ?? "").trim() || (failed.message ?? "git failed").trim();
    return refuse(attempted, said, typeof failed.code === "number" ? failed.code : undefined);
  }
}

/**
 * Whether a directory is a repository.
 *
 * `.git` is tested as a path that *exists*, not as a directory: in a linked worktree or a submodule
 * it is a file containing a `gitdir:` pointer, and treating those as non-repositories would descend
 * into them and offer their subdirectories as Projects.
 *
 * Lives here rather than in `projects.ts` because it is now asked two questions and gives the same
 * answer to both — "should discovery stop here" and "can git be asked about this Scope" — and every
 * worktree this module creates is precisely the `.git`-as-a-file case. One rule, one home.
 *
 * Synchronous, and the one exception to this module's async rule: it is a single `statSync`, and it
 * is the gate that stops any of the functions below spawning a process on a Scope that is not a
 * repository at all.
 */
export function isRepository(directory: string): boolean {
  return statSync(join(directory, ".git"), { throwIfNoEntry: false }) !== undefined;
}

let availability: Promise<boolean> | undefined;

/**
 * Whether this machine has git.
 *
 * git is a documented prerequisite rather than a dependency — nothing in `package.json` brings it,
 * and a single-executable build or a bare container has none. Without this, `isRepository` says
 * yes (the `.git` is right there) and every invocation then fails with ENOENT, which is the
 * "offered and broken" failure `/api/config`'s `shell` flag exists to prevent.
 *
 * Memoised on the *promise* rather than on the result, so two concurrent requests spawn one git —
 * the same reason `ShellRegistry` memoises its import that way.
 */
export function gitAvailable(): Promise<boolean> {
  availability ??= run(undefined, ["--version"], GIT_READ_TIMEOUT_MS).then((result) => result.ok);
  return availability;
}

/**
 * Where the Scope sits now.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref`, because it answers correctly on an *unborn*
 * branch: a repository freshly `git init`ed has a HEAD pointing at `refs/heads/main` with no commit
 * behind it, and `rev-parse` calls that an ambiguous argument while `symbolic-ref` simply says
 * `main`. Failing there would report a new repository as broken rather than as empty.
 *
 * A detached HEAD makes `symbolic-ref` exit non-zero, which is the signal to name the commit
 * instead — reported with `detached` set, never as a branch called `HEAD`.
 */
export async function head(scope: string): Promise<GitResult<Branch>> {
  const symbolic = await run(scope, ["symbolic-ref", "--short", "-q", "HEAD"], GIT_READ_TIMEOUT_MS);
  if (symbolic.ok) return { ok: true, value: { name: symbolic.value.trim() } };

  const commit = await run(scope, ["rev-parse", "--short", "HEAD"], GIT_READ_TIMEOUT_MS);
  if (!commit.ok) return commit;
  return { ok: true, value: { name: commit.value.trim(), detached: true } };
}

/** Local branches, most recently committed first — the order someone would want to pick from. */
export async function localBranches(scope: string): Promise<GitResult<string[]>> {
  const listed = await run(
    scope,
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    GIT_READ_TIMEOUT_MS,
  );
  if (!listed.ok) return listed;
  return { ok: true, value: listed.value.split("\n").filter((line) => line !== "") };
}

/** Whether the working tree has nothing uncommitted or untracked in it. */
export async function isClean(scope: string): Promise<GitResult<boolean>> {
  const status = await run(scope, ["status", "--porcelain"], GIT_READ_TIMEOUT_MS);
  if (!status.ok) return status;
  return { ok: true, value: status.value.trim() === "" };
}

/**
 * A branch name that git would read as an option.
 *
 * Refused before invoking rather than passed on, because `git switch` has no `--` to hide a name
 * behind, and the failure it produces otherwise is git complaining about a flag nobody typed.
 */
function optionLike(branch: string): boolean {
  return branch.startsWith("-");
}

/**
 * Move the Scope to another branch.
 *
 * `switch` rather than `checkout`: `checkout` also means "restore these paths", so a branch name
 * that happens to also be a path resolves to the wrong one of the two.
 */
export async function switchBranch(scope: string, branch: string): Promise<GitResult<Branch>> {
  if (optionLike(branch)) return refuse(`switch ${branch}`, `not a branch name: ${branch}`);

  const switched = await run(scope, ["switch", branch], GIT_WRITE_TIMEOUT_MS);
  if (!switched.ok) return switched;
  return head(scope);
}

/**
 * A branch name as one path segment.
 *
 * Lossy on purpose, and safe to be: nothing ever reads a branch back out of a path, because
 * `SessionMeta.worktree` records the real name. So the segment only has to be unique and legible,
 * and uniqueness is settled by probing for a free one rather than by an escaping scheme that would
 * make the path unreadable to keep a round trip nobody performs.
 *
 * The leading `flow/` of a derived name is dropped: that namespace exists to say who made
 * the branch when read inside the repository, and inside `<stateRoot>/worktrees` it is already said
 * by where the directory is. Keeping it would put "flow-" in front of every label.
 */
export function flattenBranch(branch: string): string {
  const named = branch.startsWith(NAMESPACE) ? branch.slice(NAMESPACE.length) : branch;
  const segment = named
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return segment === "" ? "branch" : segment;
}

/**
 * The branch a new worktree gets when nobody named one.
 *
 * `flow/<base-leaf>-<date>`: the namespace so `git branch` in the reader's own terminal says
 * who made it — a branch ref always survives a reap, so these accumulate and have to be
 * identifiable six months later — the base branch's own leaf so two are distinguishable at a
 * glance, and the date because that is the fact someone actually uses to decide whether they still
 * care.
 *
 * **Exactly two segments, always.** Git refs are files, so `refs/heads/flow/main` cannot
 * exist while `refs/heads/flow/main/2` does. Any scheme with a variable number of segments
 * is a trap that fires on the second worktree of the day, so the counter goes inside the last
 * segment and never adds one.
 */
export function derivedBranchName(options: { from: string; now: Date }): string {
  const leaf = flattenBranch(options.from.split("/").pop() ?? options.from);
  const date = options.now.toISOString().slice(0, 10);
  return `${NAMESPACE}${leaf}-${date}`;
}

async function refExists(repo: string, branch: string): Promise<boolean> {
  const found = await run(
    repo,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    GIT_READ_TIMEOUT_MS,
  );
  return found.ok;
}

/** `base`, then `base-2`, `base-3` — the counter inside the last segment, never a new one. */
function candidate(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}-${attempt}`;
}

export type WorktreePlan = { branch: string; path: string };

/**
 * The branch and directory a new worktree would take.
 *
 * The two are probed **independently**, because they collide for unrelated reasons: the directory
 * sits under the repository's *basename*, so `~/a/api` and `~/b/api` share one, and coupling the
 * probes would bump a branch name because an unrelated repository had a name clash — leaving a
 * branch called `flow/main-2026-09-04-2` for a reason nobody could reconstruct.
 *
 * A name the reader supplied is never bumped. Someone who typed a name and got a different one has
 * been ignored, so an existing ref is a failure carrying git's own conclusion; bumping exists only
 * for the derived name, and only because the TUI never types and would otherwise be stuck on the
 * second worktree of the day.
 */
export async function planWorktree(options: {
  repo: string;
  from: string;
  branch?: string;
  under: string;
  now?: Date;
}): Promise<GitResult<WorktreePlan>> {
  const { repo, from, under } = options;
  const attempted = `worktree add (from ${from})`;

  if (options.branch !== undefined && optionLike(options.branch)) {
    return refuse(attempted, `not a branch name: ${options.branch}`);
  }
  if (optionLike(from)) return refuse(attempted, `not a branch name: ${from}`);

  let branch: string | undefined;
  if (options.branch !== undefined) {
    if (await refExists(repo, options.branch)) {
      return refuse(attempted, `a branch named '${options.branch}' already exists`);
    }
    branch = options.branch;
  } else {
    const base = derivedBranchName({ from, now: options.now ?? new Date() });
    for (let attempt = 1; attempt <= MAX_CANDIDATES; attempt += 1) {
      const name = candidate(base, attempt);
      if (!(await refExists(repo, name))) {
        branch = name;
        break;
      }
    }
    if (branch === undefined) {
      return refuse(attempted, `no free branch name after ${MAX_CANDIDATES} attempts from ${base}`);
    }
  }

  const home = join(under, basename(repo));
  const segment = flattenBranch(branch);
  for (let attempt = 1; attempt <= MAX_CANDIDATES; attempt += 1) {
    const path = join(home, candidate(segment, attempt));
    if (!existsSync(path)) return { ok: true, value: { branch, path } };
  }
  return refuse(attempted, `no free directory after ${MAX_CANDIDATES} attempts in ${home}`);
}

/**
 * Cut a new branch from `from` into a fresh worktree.
 *
 * `-b` is what makes a base branch that is already checked out elsewhere a non-problem: `from` is
 * never checked out, only cut from. Without it, starting a second Agent Session from `main` while
 * the repository itself sits on `main` would be refused by git.
 */
export async function createWorktree(options: {
  repo: string;
  from: string;
  branch?: string;
  under: string;
  now?: Date;
}): Promise<GitResult<WorktreePlan>> {
  const planned = await planWorktree(options);
  if (!planned.ok) return planned;

  const { branch, path } = planned.value;
  // The leading `<under>/<repo>` is left to git, which creates it. Pre-creating it here left an
  // empty directory behind whenever `worktree add` then failed — a failed creation must leave
  // nothing, because the caller is about to decide there is no Agent Session either.
  const added = await run(
    options.repo,
    ["worktree", "add", "-b", branch, path, options.from],
    GIT_WRITE_TIMEOUT_MS,
  );
  if (!added.ok) return added;
  return { ok: true, value: planned.value };
}

/**
 * Remove a worktree this host created.
 *
 * Deliberately no `--force`: the caller has already established the working tree is clean, and a
 * `--force` here would make that check decorative — the whole point is that uncommitted work is
 * never deleted on a timer. Run from the repository rather than from the worktree, so a directory
 * already gone by other means still gets its administrative entry pruned.
 */
export async function removeWorktree(options: {
  repo: string;
  path: string;
}): Promise<GitResult<void>> {
  const removed = await run(
    options.repo,
    ["worktree", "remove", options.path],
    GIT_WRITE_TIMEOUT_MS,
  );
  if (!removed.ok) return removed;
  return { ok: true, value: undefined };
}
