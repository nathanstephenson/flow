# systemd keeps Session Host ownership during self-update

A systemd-managed Session Host remains a foreground process. It must not become a Flow-owned
background host during an update: systemd tracks the service's process and cgroup, and detaching an
updater child does not move that child outside the service's kill boundary.

Opt-in systemd updates therefore run in a distinct, preconfigured updater service. Both the Session
Host and the updater run as the installation's non-root owner. For a system service, administrator
configuration grants only the fixed unit start/stop operations required by the update; Flow does not
receive general sudo, transient-unit creation, or permission to run package installation as root.
User services use the user's own service manager.

The updater verifies systemd's MainPID ownership before stopping anything. The existing authenticated
host-control boundary checks active work and closes admission without exiting the Session Host.
The updater then asks systemd to stop the service, preventing its restart policy from competing with
package replacement. Ordinary foreground and embedded hosts remain unsupported.

The installation lease, cross-root exclusion, persistent update barrier, exact-version verification,
and rollback remain shared with background-host updating. A narrowly bound, one-use startup
capability allows the configured foreground service to restart through the barrier. The updater
checks the new Session Host's identity, version, settings, and systemd ownership before completing.
Uncertain replacement or unsuccessful recovery leaves the guard in place for manual repair.

The browser only requests the fixed configured updater and its confirmed release. Durable status
survives the browser disconnect and Session Host restart. This does not guarantee recovery from a
broken installation or service definition: administrative access remains necessary for repair.
