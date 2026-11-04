# Git: publishing and stacked pull requests

## Publish branch names

Before the first push, Publish shows a branch name that you can edit.

- Flow uses the Summary Model to suggest the name, if one is configured. Otherwise it uses a local
  fallback.
- When you confirm, Flow creates a feature branch from the default branch, or renames an
  unpublished branch.
- Published branches and registered stack branches keep their names.
- Flow does not change branches while it prepares the review.

## Stacked pull requests

The Git tab in the browser uses `github/gh-stack` directly. It is tested with v0.1.1.

Install and authenticate it on the Session Host machine:

```bash
gh extension install github/gh-stack
gh auth login
```

Without it, the ordinary Git controls are still available.

Stack supports Create, Add, Switch, Submit, Sync and Rebase. Merge and stack restructuring are not
available.

### Rules for all stack operations

- Switching and changes require that no Agent Session in the same Scope is working, including
  background work.
- The working tree must be clean, except to continue or abort a conflict. Flow never stashes
  changes. Use Publish for uncommitted files.
- Stack branches use their active parent as the review base, and as the base for new PRs.

### Create

- Flow offers Create only for a clear chain of at least two existing local branches, linked by PR
  head and base relationships.
- Commit ancestry alone does not identify a stack.
- Merged members keep their status.
- Create registers the branches shown. It never accepts names for new branches.
- Flow does not offer ambiguous chains, or branches that a stack already tracks.

### Switch

Switch selects only local stack branches. Numeric branch names are included.

### Submit and Sync

Submit and Sync need a fresh review of the affected branches and PRs.

- Submit uses `gh stack submit --auto`. New PRs are drafts. The draft state of existing PRs does
  not change.
- Sync examines remote stack membership at review and at confirmation. It then fetches, rebases and
  pushes.
- If membership is different, reconcile it with `gh stack` outside Flow. Then review again.
- API failures block Sync.
- The CLI cannot lock remote membership. Changes after the final check are still a race.
- After a Sync conflict, use Rebase to resolve it locally. Then confirm Sync again. Flow does not
  retry or push automatically.

### Rebase conflicts

A paused Rebase shows the conflict files, **Continue** and **Abort**.

**Ask agent to fix, then continue** sends a normal message to the current Agent Session. The message
asks the agent to resolve and stage the conflicts, then to run `gh stack rebase --continue` only when
they are resolved.

- This does not give permission to publish, push, sync or merge.
- Examine the result, then refresh Stack.

### Copy

- **Copy stack** copies the PR titles as formatted links, from top to bottom.
- **Copy PR link** copies one PR.
- A plain-text paste contains only the titles.
