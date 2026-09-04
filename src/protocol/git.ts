/**
 * Git, as it crosses the wire.
 *
 * In the protocol rather than beside `src/daemon/git.ts` because both ends need the same shape: the
 * Session Host reports a Branch on every SessionSummary and answers `/api/branches` with a
 * BranchList, and both front-ends render them. `src/daemon/git.ts` owns how git is *asked*; this
 * file owns only what the answers look like.
 *
 * Nothing here describes an operation. A switch is a Command and a worktree is a field on `create`,
 * because both are things done to one Agent Session and the command door already carries those.
 */

export type Branch = {
  /** The branch name, or the abbreviated commit when HEAD is detached. What a client shows. */
  name: string;
  /**
   * Set when `name` is a commit rather than a branch.
   *
   * A detached HEAD is a real state someone can leave a checkout in, and reporting it as a branch
   * called `HEAD` would be a lie a client would then offer to switch away from — so the state is
   * named rather than flattened into the common case.
   */
  detached?: true;
};

export type BranchList = {
  /** Echoed back, so a client can discard an answer to a Scope its reader has moved on from. */
  scope: string;
  /**
   * Whether the Scope is a git repository.
   *
   * Required rather than `repository?: true`, because three states have to stay distinguishable —
   * not a repository, a repository with no commits, and a repository on a branch — and an absent
   * optional would collapse the first two into "no branches". A Project need not be a repository at
   * all (ADR 0011), so this is an ordinary answer rather than an error.
   */
  repository: boolean;
  /** Local branches, most recently committed first. Empty in a repository with no commits yet. */
  branches: string[];
  /**
   * Where the Scope sits now, so a client can mark it. Absent only when the Scope is not a
   * repository — a repository with no commits still reports the unborn branch it is on, because a
   * new checkout is empty rather than broken.
   */
  head?: Branch;
  /** Set when the list was cut short, the same courtesy `DirectoryMatches` extends. */
  truncated?: true;
};
