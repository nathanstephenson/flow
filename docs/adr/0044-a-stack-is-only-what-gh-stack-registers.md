# 44. A Stack is only what gh stack registers

## Status

Accepted. Reverses the stack discovery of NAT-64 (#47), which showed stacks inferred from native
GitHub stacks, pull request bases and commit ancestry.

## Decision

The Stack tab shows only the Stack that `gh stack view --json` reports for the current branch. That
is a Stack registered in the clone of the Scope. Flow does not infer a Stack, and it does not show a
graph of related branches.

On a branch that is not in a Stack, the tab shows a Create stack form. The owner chooses the trunk
and an ordered list of local branches. The daemon makes sure that each name is a local branch, that
no branch is the trunk or is listed twice, and that no branch is already in a Stack. Then it runs
`gh stack init --base <trunk> <branches>`.

The PR titles for the copy action come from one GraphQL query for all PR numbers of the view. The
daemon reads them again when a PR number or state changes, and otherwise after 5 minutes.

On the trunk of a registered Stack, the tab shows one line and does not run `gh stack view`, which
fails or shows no current branch there. So every shown Stack permits every Stack action.

`stack_status` does not run under the Git operation lock, so the tab loads during an agent turn.
Stack writes stay under the lock. `gh stack view` rewrites the stack metadata file with no lock of
its own, so Flow runs every `gh stack` command one at a time for each repository, keyed by the
common Git directory: a read waits for a running write and a write waits for a running read.

`gh stack` keeps one rebase state for all worktrees of a repository. Flow offers Continue, Abort
and Ask agent only in the worktree that has the Git rebase in progress. Other worktrees show one
line and refuse Stack writes.

## Considered options

- **Keep discovery and show it read-only.** Four relationship sources (native stacks, local
  metadata, pull request bases, ancestry) can disagree. The code had to resolve conflicts, cycles
  and ambiguous parents, and a shown graph did not permit the Stack actions. It also read all open
  pull requests and the merged history of the repository on each status read.
- **Offer Create stack only for an inferred chain.** The owner could not choose the trunk or the
  order, and a chain with one gap could not be registered at all.

## Consequences

Lost: Flow no longer shows stacked pull requests that `gh stack` has not registered, or a Stack that
is registered only on GitHub or in another clone. The owner runs `gh stack checkout <PR number>` to
register such a Stack in the Scope.

Gained: one source for each shown Stack, and every shown Stack permits every Stack action. The
daemon code for stacks is much smaller. A status read calls GitHub through `gh stack view`, and for
titles through one repository lookup (once for each Scope and remote) and one title query at most
each 5 minutes or when the PRs change. A PR that cannot be found costs one more query.

The queue covers only the `gh stack` commands that Flow runs. A `gh stack` command run in a terminal
at the same time can still lose a metadata write. A Stack read waits for a running Stack write, so
the tab can show its last list for the length of a Submit or Sync. A rebase stopped in one worktree
blocks Stack writes in all worktrees of the repository until it is continued or aborted there.
