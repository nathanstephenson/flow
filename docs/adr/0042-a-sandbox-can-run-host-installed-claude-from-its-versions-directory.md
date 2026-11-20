# 42. A Sandbox can run host-installed Claude from its versions directory

## Status

Accepted. Amends ADR 0032 and ADR 0034.

## Decision

The Sandbox Provider names Claude with at most one of `claudePath` (a guest path, as in ADR 0032)
or `hostClaudePath` (a host path). With neither, Flow does not set `FLOW_CLAUDE_PATH`, and the Claude
SDK runs the Claude in Flow's own `node_modules`, which the VM already mounts read-only. That works
when Flow was installed on Linux for the guest's CPU and libc, the same as Pi, which needs only the
guest's `nodePath`. A guest install in the base environment makes each VM create slow, so
`hostClaudePath` lets the VM use the host's own native install, with its own update schedule.

The native install is a symlink, such as `~/.local/bin/claude`, to one self-contained executable in
a versions directory, such as `~/.local/share/claude/versions/<version>`. When a sandbox Backend
Session starts, Flow resolves the symlink, checks that the file is a 64-bit ELF executable for the
host CPU, and mounts the versions directory read-only. The guest runs the resolved file with
`DISABLE_AUTOUPDATER=1`. Flow refuses the work if a check fails, and also if the directory holds
anything other than regular files, because a same-path mount of a general directory such as
`/usr/local/bin` would hide the guest's own files.

A Shared Sandbox mounts the versions directory for all its sessions, as it does `claudeAuthDir`.

## Considered options

- **Mount only the resolved file.** Smaller, but each host update changes the mount. A Shared
  Sandbox would then be replaced, or refused while it is in use.
- **Run the executable in the guest before the worker starts.** This finds a guest libc mismatch
  early, but adds one provider exec to every sandbox start. The Claude SDK already reports a libc
  mismatch when the launch fails.

## Consequences

Host updates apply to new Backend Sessions and Revives. A running session uses its resolved version
until the host removes that file. Only Linux hosts whose guest has a compatible libc can use
`hostClaudePath`; macOS hosts still need a guest install.
