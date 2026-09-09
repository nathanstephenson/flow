/**
 * The segment of a Scope a reader would call the Project.
 *
 * The leading directories are dropped rather than dimmed: they are the same for every Agent Session
 * on this machine, so they cost a line's width to say nothing. A Scope that leaves no segment (`/`,
 * or a trailing slash) falls back to the Scope verbatim, because an empty header names nothing.
 *
 * **A worktree Scope is the exception, and it is the same rule rather than a new one.** That
 * premise above — that the leading directories say nothing because they are shared — is false for a
 * worktree: it ends `<repo>/<branch>`, so its parent is the repository and is the one segment worth
 * reading, while its basename is the branch the control beside this already names. So the same
 * question is asked one segment higher up. A flag rather than the repository's name over the wire,
 * because the name is already here in the Scope.
 */
export function projectName(scope: string, worktree?: true): string {
  const path = worktree ? scope.slice(0, Math.max(0, scope.lastIndexOf("/"))) : scope;
  const cut = path.lastIndexOf("/");
  return (cut < 0 ? path : path.slice(cut + 1)) || scope;
}
