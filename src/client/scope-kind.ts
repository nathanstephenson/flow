/**
 * What kind of Scope an Agent Session is bound to, in words.
 *
 * Here rather than in either front-end for the reason `context-usage.ts` is: this is one sentence
 * both of them have to say identically, and the last time wording like this lived in two places the
 * two places drifted.
 *
 * **Not "Local checkout".** That phrase contrasts with a remote or hosted one, and GoodHarness has
 * no such thing — local mode is the only mode there is (README), so "Local" would distinguish
 * nothing today and would be actively wrong on the day it does. The contrast that is real is
 * between the Project's own checkout and a Worktree cut from it, so that is the one named.
 */
export function scopeKindLabel(scope: { worktree?: true }): string {
  return scope.worktree ? "Worktree" : "Project checkout";
}

/**
 * Why the checkout is a label and never a control.
 *
 * A Scope is fixed for an Agent Session's whole life, so there is no version of this someone could
 * change from here — a different directory is a different Agent Session. Exported as prose because
 * both front-ends want to say it: the web client as a tooltip, and it is the reason the TUI's
 * branch overlay offers no way to move between checkouts.
 */
export function scopeKindHint(scope: { worktree?: true }): string {
  return scope.worktree
    ? "A worktree the Session Host made for this Agent Session. It is bound to it for its whole life."
    : "The Project's own checkout. This Agent Session is bound to it for its whole life.";
}
