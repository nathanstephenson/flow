# 32. Sandbox isolation runs each Agent Session in an sbx VM

## Status

Accepted. Amends ADR 0028: the boolean `filesystemIsolation` becomes a mode.

## Decision

`filesystemIsolation` is `"none" | "bubblewrap" | "sandbox"`. Omission is automatic: Bubblewrap when
its launch check passes, otherwise none. Automatic never selects sandbox. Stored `true` and `false`
load as `"bubblewrap"` and `"none"`. Every restricted mode fails closed: when its launch fails,
work does not start, and Flow never falls back to another mode.

Sandbox mode targets Docker Sandboxes (`sbx`) only. The Session Host reads a sandbox provider file
once at startup, from `FLOW_SANDBOX_PROVIDER` or `<state root>/sandbox-provider.json`. It holds
`version: 1`, the guest's absolute `nodePath` and `claudePath`, an optional `claudeAuthDir`, and argv
templates for `probe`, `create`, `exec` and `remove`. Placeholders are whole argv elements and are
replaced without a shell. Sandbox mode is available only when `probe` exits 0.

Each Agent Session gets one VM. Flow writes `<backendDir>/sandbox.json` as an `sbxenv` fragment
(`name`, `workspace` = Scope, `additionalWorkspaces`, `env`). `sbx env create` merges it over the
base environment named in the provider file, for example the output of `harness plan --out`. Paths
are the same inside and outside the VM. Flow checks each mount's device and inode just before
`create`. It never restarts a VM: a Revive removes any VM left from before and makes a new one, and
Flow removes the VM when the session's work stops.

Every guest command runs under an inline Node supervisor (`node -e`), so nothing is installed in
the VM. It relays stdio through its own pipes, marks the command's environment, and when stdin
closes or the command exits, it stops every process with that marker. This stops one command tree,
including `setsid` and detached children, without affecting other commands in the VM.

In sandbox mode a Shell runs in the session's VM through the optional `shell` argv template, without
the supervisor. When the provider file has no `shell`, Flow refuses the Shell.

The worker channel is length-prefixed `v8.serialize` frames on stdin and stdout in every mode,
because `sbx exec` carries only stdio.

## Consequences

The VM is the boundary. The guest agent user has `sudo`, so processes inside one VM are not
isolated from each other, and processes that drop the supervisor's marker or run under Docker in
the VM are stopped only when the VM is removed. Sandbox sessions start slower (tens of seconds to
create a VM). Single-executable builds and Windows hosts cannot use sandbox mode. Flow depends on
sbx's experimental `sbx env` file format.
