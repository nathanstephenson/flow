# Git: commit, push, pull requests and stacked pull requests

## Commit, push and create a pull request

The Git pane shows the next step above its tabs: Commit, Push, or Create pull request.

- Commit includes only the files that you select in the Uncommitted view. Other files keep their
  staged and unstaged state. Git hooks run.
- On the default branch or a detached HEAD, Commit requires a new branch name. You can rename a
  branch that has no pull request, no remote branch and no stack registration.
- Push sends the current branch to its push remote and sets the upstream. Flow never pushes the
  default branch. If the push replaces remote commits, Flow lists them and asks first.
- Create pull request uses the stack parent or the default branch as the base. The branch must be
  pushed.
- Suggest asks the Summary Model for text, if one is configured. It fills only empty fields.

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
  changes. Commit uncommitted files first.
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

- This does not give permission to push, sync or merge.
- Examine the result, then refresh Stack.

### Copy

- **Copy stack** copies the PR titles as formatted links, from top to bottom.
- **Copy PR link** copies one PR.
- A plain-text paste contains only the titles.
