# Updating a systemd-owned Session Host

Flow supports a foreground `Type=simple` Session Host owned by either the system or user manager. Updates still require a **private, non-root, global npm installation**. A system service with `User=agent` is supported; installing Flow into a root-owned `/usr` prefix is not. Do not run the updater as root.

The updater is a separate, fixed oneshot unit, not a detached child of the Session Host. It survives the host cgroup being stopped. Flow checks the manager's MainPID for both units, quiesces host admission using the authenticated busy-work check, stops the host through systemd, and reuses the installation lease, barrier, npm process supervision, fresh-process verification and rollback transaction. Restoration starts the original service through systemd; it never launches a background-owned host. A one-use, private capability file allows that startup through the installation barrier. The restored foreground host must report the expected version and settings and be the service's MainPID.

## One-time administrator setup (system manager)

These are examples to adapt and review, **not commands Flow runs automatically**. Substitute your absolute Node, npm prefix, home, working directory, state directory, service names and foreground arguments. Both units must use the same identity, PATH/npm configuration, state root, working directory and application/OIDC environment. Use the npm installation's `dist/cli/bootstrap.js`, not the source entrypoint or a shell wrapper. `ExecStart` must leave Node as MainPID.

Keep the existing host's environment and foreground arguments; add `FLOW_SYSTEMD_HOST=1`. For example `/etc/systemd/system/flow.service`:

```ini
[Unit]
Description=Flow Session Host

[Service]
Type=simple
User=agent
Group=agent
WorkingDirectory=/home/agent
Environment=HOME=/home/agent
Environment=PATH=/home/agent/.local/bin:/usr/bin:/bin
Environment=FLOW_STATE_DIR=/home/agent/.flow
Environment=FLOW_SYSTEMD_HOST=1
ExecStart=/usr/bin/node /home/agent/.local/lib/node_modules/@nathanstephenson/flow/dist/cli/bootstrap.js serve --port 4317 --address 127.0.0.1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/flow-update.service`:

```ini
[Unit]
Description=Guarded Flow update

[Service]
Type=oneshot
User=agent
Group=agent
WorkingDirectory=/home/agent
Environment=HOME=/home/agent
Environment=PATH=/home/agent/.local/bin:/usr/bin:/bin
Environment=FLOW_STATE_DIR=/home/agent/.flow
Environment=FLOW_SYSTEMD_WORKER=1
ExecStart=/usr/bin/node /home/agent/.local/lib/node_modules/@nathanstephenson/flow/dist/cli/bootstrap.js update
TimeoutStartSec=infinity
Restart=no
```

Do **not** add `PartOf=flow.service`, `BindsTo=flow.service`, `Conflicts=flow.service`, or a dependency that stops the updater along with the host. Do not use `+`/`!` ExecStart prefixes, root lifecycle hooks, root shell wrappers, or sudo to execute Flow. Node and npm (including lifecycle scripts) run only as `agent`. Do not enable the update unit on boot: it requires a queued request. Restrictive sandboxing must still permit the user's npm prefix, state and npm cache to be written and the manager's D-Bus to be reached.

Grant narrowly scoped manager authority via a root-owned, non-user-writable polkit rule, e.g. `/etc/polkit-1/rules.d/50-flow-update.rules`:

```js
polkit.addRule(function(action, subject) {
  if (action.id !== "org.freedesktop.systemd1.manage-units" || subject.user !== "agent") return;
  var unit = action.lookup("unit");
  var verb = action.lookup("verb");
  if ((unit === "flow-update.service" && verb === "start") ||
      (unit === "flow.service" && (verb === "start" || verb === "stop"))) {
    return polkit.Result.YES;
  }
});
```

This grants the account (not just Flow) start/stop of that one host and start of the updater. It does **not** grant manager reload, unit editing, enabling, arbitrary unit control, transient unit creation or arbitrary root commands. Keep both unit files and any manager drop-ins root-owned and non-user-writable. No user-writable code executes as root. Review other local authorization rules that could already grant broader authority. The administrator installs the files, runs `systemctl daemon-reload`, and restarts the host once when convenient. Flow never installs policy or modifies live units.

As `agent`, create private `/home/agent/.flow/systemd-update.json` (mode 0600):

```json
{
  "scope": "system",
  "service": "flow.service",
  "updater": "flow-update.service",
  "hostArgs": ["serve", "--port", "4317", "--address", "127.0.0.1"]
}
```

`hostArgs` must match the host's exact bootstrap arguments, including ordering. Names must be fixed `.service` units (no templates, paths or options). Use a fixed port for browser reconnection; web updates refuse an ephemeral (`--port 0`) service before stopping it. Keep this configuration consistent in the host and updater. Use the matching npm in PATH and the same npm prefix configuration as the installation.

## User manager

Use the same configuration with `"scope": "user"`, place units in `~/.config/systemd/user/`, omit `User=` and `Group=`, and use `WantedBy=default.target`. No polkit grant is necessary. The account's user manager must be running and reachable (`XDG_RUNTIME_DIR`/D-Bus environment available to both units and CLI); configure lingering administratively if operation without a login is needed. The updater must still be a separate unit.

## Operation and recovery

`flow update [--force]` queues the fixed updater and returns after submission; it does not wait for completion. Follow `journalctl -u flow-update.service` (or `journalctl --user -u ...`) for the final result. Close other CLI/TUI clients first. `--force` is CLI-only. Web Settings use the same unit with a pinned, confirmed stable release and persisted success/failure status. Busy work is checked again by the host immediately before systemd stop. Directly starting the updater without a queued request fails without mutation.

If systemd definitively refuses to stop the service (for example, missing polkit authorization), Flow reopens admission only after verifying that the original process still owns the active service and no manager job is pending. No package files are changed. An uncertain stop or real shutdown is never undone this way.

The exclusive `systemd-update-request.json` serializes CLI and web launches. If submission times out or a worker is killed, do not retry blindly: inspect unit status and journal. Web status becomes unverified if its worker disappears. A crash after admission is quiesced may leave the host unavailable; a crash after replacement begins retains the installation barrier. Flow refuses unsafe automatic recovery when process/package state is uncertain.

Follow README's manual installation repair procedure before removing the barrier. After confirming both units and all npm/Flow processes using the prefix are stopped and repairing/verifying the package, remove any stale `systemd-update-request.json` and `systemd-update-capability` from the state root. For an unverified web operation, archive/remove `web-update.json` only after manual verification. Start the host with systemd, not `flow serve start`. Do not delete any of these records during a live update.

If service startup fails, Flow stops the attempted restoration before trying the previous npm version. A rollback failure leaves the guard in place and reports manual repair instructions. This is best-effort reinstallation, not a preserved snapshot, and cannot guarantee recovery after power loss, SIGKILL, loss of manager access, or registry/network failures.
