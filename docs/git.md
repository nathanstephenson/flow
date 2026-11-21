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

## Pull request tab

The Pull request tab shows the pull request of the current branch in four sections: Overview,
Checks, Review threads and Comments and reviews. Failing checks and unresolved threads are first.
Resolved threads are collapsed.

- Merge, Rebase, Edit, and Ready for review or Convert to draft are at the top. Merge and Rebase
  ask first.
- Refresh in the Git pane header reads the local Git State, the pull request, and the Changes and
  Pull request tabs again. The Stack tab has its own Refresh stack.
- Rebase changes only the local branch. It requires a clean Scope, aborts on a conflict and pushes
  nothing.
- Re-run failed jobs runs the failed jobs of one GitHub Actions run again. It shows once for each
  run that has a failed job. Flow refuses a run that is not for the current head.
- Each action first makes sure that the pull request is still the one of the current branch.
- The tab reads the pull request again when the polled Git State of the pull request changes. It does
  not read again when the pull request it shows has the same update time, state and checks.

The rail row shows two icons at the end of the branch line: the pull request state and its check
status. The session header shows the pull request number as a link, followed by the same icons. A
tooltip gives the words, for example "Pull Request #178. Draft. Checks passing."

## Stacked pull requests

The Stack tab uses `github/gh-stack` directly. It is tested with v0.3.0.

Install and authenticate it on the Session Host machine:

```bash
gh extension install github/gh-stack
gh auth login
```

Without it, the Stack tab is hidden. The ordinary Git controls are still available.

The Stack tab shows only the Stack that `gh stack view` reports for the current branch. Flow does
not infer a Stack from pull request bases or from commit ancestry, and it does not show a Stack
that is only on GitHub or only in another clone. To show a Stack from GitHub, run
`gh stack checkout <PR number>` in the Scope. See ADR 0044.

- On a branch in a Stack, the tab lists the branches from top to bottom, then the trunk. Each row
  shows the PR number, state and title, and "Needs rebase", "Merged" or "Queued" when they apply.
- On a branch that is not in a Stack, the tab shows the Create stack form.
- On a trunk or a detached HEAD, the tab shows one line of text.
- The tab reads the Stack again when the branch, the head commit or the pull request changes.
  The tab can load while an agent turn runs. Stack actions cannot.

Stack supports Create, Add, Switch, Submit, Sync and Rebase. Merge and stack restructuring are not
available.

### Rules for all stack operations

- Switching and changes require that no Agent Session in the same Scope is working, including
  background work.
- The working tree must be clean, except to continue or abort a conflict. Flow never stashes
  changes. Commit uncommitted files first.
- Stack branches use their active parent as the review base, and as the base for new PRs.

### Create

- Choose the trunk. The default is the default branch of the remote.
- Add local branches that are not in a Stack. Put them in order from top to bottom with the move
  buttons. The current branch is in the list first.
- A branch cannot also be the trunk, and a branch can be in the list only once.
- Create stack runs `gh stack init --base <trunk>` with the branches from bottom to top. It does not
  create branches. It then switches to the top branch.
- `gh stack init` does not require that each branch contains the branch below it. Rebase puts the
  branches on top of each other.

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
- Flow reads the titles with one GitHub query for all PRs of the Stack. It reads them again only
  when a PR number or state changes.
