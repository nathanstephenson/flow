# Updating Flow

Updates are never automatic. No version argument is accepted.

## Update from the command line

```bash
flow update [--force]
```

`flow update` installs `@nathanstephenson/flow@latest` with the npm that `PATH` selects.

Before you update:

1. Close all CLI and TUI clients.
2. Stop other Session Hosts that use this installation, including hosts under other
   `FLOW_STATE_DIR` roots.
3. Make sure that the same OIDC configuration is present.

The background Session Host of the selected state root can stay running. Flow stops it, updates,
then starts a new process with the saved address, port, working directory and OIDC settings.

- Use `--force` to interrupt active work.
- Flow refuses unmanaged foreground hosts and embedded hosts.
- The restored host writes its output to the private `host.log` of the selected state root.
- If the version does not change, Flow reports it as unchanged.

## Update from the browser

An authorised browser can do the same guarded update from **Settings → General → Flow update**. The
browser must connect to a background Session Host or a configured systemd-owned Session Host. You
must confirm the update.

- The browser checks only npm's stable `latest` tag.
- The browser cannot select a package, version or path.
- The browser cannot force active work to stop.
- After the update, the browser reconnects on the same address and port. It then verifies the
  running version.

## Supported installations

The global prefix must match this exact installation.

- Only user-owned prefixes are supported. The prefix must not have group or other write access.
- Its ancestor directories must also prevent replacement by other users.
- Self-update does not support source runs, `npm link`, root or sudo installs, shared prefixes or
  the single executable (SEA). Ordinary commands still work for these installations.
- To update a shared or system installation, stop all Flow processes. Then update it manually with
  npm.

For foreground systemd services, including system units with `User=agent`, read
[systemd-updates.md](systemd-updates.md). A separate non-root updater unit keeps service
ownership. An administrator configures its narrow start and stop authority once.

## First adoption of this release

Before you first adopt this release, stop **all** older Flow processes. Old processes have no
installation lease, and Flow cannot reliably detect them.

External `npm install` commands do not obey Flow's guard. Never run them while Flow is active or
while an update is in progress.

## The installation guard

For eligible private installations, the guard registers every CLI process before it loads
application code.

- Use `flow` to start Flow. Do not run `dist/cli/main.js` directly.
- Registry errors, or changed permissions on an installation that is already guarded, prevent
  startup. They do not disable the guard.
- During an update, the guard blocks new starts across all state roots until the update and the
  restoration finish.

## When an update fails

On failure, Flow tries to reinstall the previous exact version and restore the host. This is
best-effort recovery. It does not keep the old package files.

- A failed update exits with a nonzero status, even if recovery succeeds.
- npm's process group must stop before verification or rollback. If Flow cannot confirm that it
  stopped, Flow keeps the recovery barrier.
- Lifecycle scripts that detach into a different process group are not supported.

## Manual repair

If the updater stops unexpectedly or recovery fails, startup stays blocked. The error message names
`<prefix>/.flow-installations/<slot>/update.json`.

1. Do not remove `update.json` while an updater, an npm child or a Flow process can still run.
2. Stop all of these processes.
3. With the matching npm, reinstall the previous version. The record stores `previous`:

   ```bash
   npm install --global --prefix <prefix> @nathanstephenson/flow@<previous>
   ```

4. Compare the package name and version, `dist/build-id` and the bundled `dist/cli/bootstrap.js`
   with a trusted package archive.
5. When the repair is complete, remove that `update.json`.
6. Run `flow --version`.
7. Start the Session Host again.

Do not delete a live registry mutex.
