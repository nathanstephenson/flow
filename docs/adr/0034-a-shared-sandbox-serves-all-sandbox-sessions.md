# 34. A Shared Sandbox serves all sandbox sessions

## Status

Accepted. Amends ADR 0032: one VM can serve all Agent Sessions in Sandbox mode.

## Decision

A new Agent Session in Sandbox mode waits tens of seconds for `sbx env create` (ADR 0032). To make
this wait occur one time only, the setting `sandboxSharing` is `"session" | "shared"`. The default is
`"session"`: one VM for each Agent Session, as in ADR 0032. With `"shared"`, the Session Host keeps
one Shared Sandbox for all its sandbox sessions, including Workflow builders. Workflow code and MCP
clients of a session run in the same VM as its worker. Flow reads the setting when a Backend Session
starts.

sbx cannot add mounts to a VM after create. Thus the Shared Sandbox mounts fixed roots at create:

- writable: the Project Root, `<state root>/worktrees`, `<state root>/sessions`, and the Workflow
  builder folder `<tmpdir>/flow-workflow-builders`;
- writable: `claudeAuthDir`, if the Sandbox Provider sets it;
- read-only: the assets that a per-session VM mounts (the Flow package, `node_modules`, Claude
  extras).

The VM name is `flow-shared-<hash of state root>`, and its spec is `<state root>/sandbox/shared.json`.

Flow refuses a session whose Scope is not under the Project Root, the Worktrees folder or the builder
folder. Flow also refuses all shared sessions when no Project Root is set. The error names the
Project Root. Flow never falls back to a per-session VM.

Throwaway Summary Model sessions (ADR 0020) use the empty folder `flow-workflow-builders/summary` as
their Scope. Thus they run in the shared VM with no new mount. The old Scope, the temporary
directory, failed in both modes: `/tmp` is a reserved isolation path.

Flow creates the VM for the first shared session and keeps it while the Session Host runs. Each
session holds the VM and releases it when its work stops. When the Session Host stops, Flow removes
the VM after all holds are released. If a VM is left from a crash, Flow removes it before the next
create. If a session needs a mount that the VM does not have (for example, after a Project Root
change), Flow removes and creates the VM again when no session holds it. Otherwise Flow refuses the
session.

## Consequences

Only the first shared session waits for VM create. All processes in the VM can read and write the
state, transcripts and files of all sessions and all Projects under the Project Root. A stuck or busy
session can make all other sessions slow. A Project Root change takes effect only when no session
holds the VM. The supervisor (ADR 0032) still stops one command tree without an effect on the other
sessions.

## Evictable holds amendment

A hold can be evictable. Warm Skills sessions (ADR 0035) take evictable holds. If a session needs a
mount that the VM does not have, and all holds are evictable, Flow asks each holder to release. Flow
then waits for the releases and creates the VM again. If one hold is not evictable, Flow refuses the
session, as before.
