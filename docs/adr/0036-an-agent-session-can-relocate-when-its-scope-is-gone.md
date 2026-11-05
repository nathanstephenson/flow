# An Agent Session can relocate when its Scope is gone

Amends ADR 0013.

ADR 0013 says that a Scope is fixed for the life of an Agent Session. This stays true while the
Scope folder exists. But a Scope can stop existing while the Presentation Transcript stays readable.
For example, Flow ran in a Linux container, and now runs on macOS with the same state root. The
stored Scope is `/home/node/...`, and Revive cannot start a Backend Session there.

**Revive refuses a missing Scope.** Before Revive starts anything, it checks that the Scope exists.
If not, it refuses with the code `scope_missing` (409). Before this change, the user got a 500.

**Relocate is allowed only when the Scope is gone.** The `relocate` command binds a stopped Agent
Session to a new folder. The host refuses it when:
- a Backend Session runs or starts,
- the old Scope still exists,
- the new folder does not exist or fails the same check as a restricted launch
  (`validateFilesystemScope`).

Flow does not choose the folder. It suggests one, and the user confirms it:
- Scope: the same `worktrees/<repo>/<branch>` under this state root, if it exists.
- Repository: the Project with the same folder name.

**A Worktree also needs its repository.** The user gives the new repository folder. Flow runs
`git worktree repair` and then reads back the link. If the link is not correct, Flow refuses and
changes nothing.

**The backend record moves with the Scope.** Claude keys its records by the Scope, so Flow renames
the record folder. pi reopens a session only when the `cwd` in its header matches, so Flow writes the
new `cwd`. Flow writes the session meta last. If that write fails, Flow moves the record back.

**The transcript shows the new Scope.** The `revived` event carries the Scope. A client reads the
Scope from it, so the branch control uses the new folder.

A user cannot relocate an Agent Session whose Scope exists. That remains a new Agent Session.
