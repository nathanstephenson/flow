# Operating the Session Host

This page describes how to run, stop and restart a Session Host. The quick start is in the
[README](../README.md#first-run).

## Foreground and background hosts

| Command | Action |
| --- | --- |
| `flow serve [--port N] [--address HOST]` | Run the Session Host in the foreground. |
| `flow serve start` | Start a background Session Host. |
| `flow serve status` | Show the installed and running versions. |
| `flow serve stop [--force]` | Stop the background Session Host. |
| `flow serve restart [--force]` | Restart the background Session Host. |

- `flow serve` binds to `127.0.0.1` by default.
- `flow serve restart` restarts only a host that was started in the background. It uses the saved
  address, port and working directory.
- A saved port of `0` stays dynamic.
- Restart requires the same OIDC configuration as the original start.
- A background host writes its output to the private `host.log` in its state root.

## Stopping with active work

Stop and restart refuse active work unless you add `--force`.

- `--force` interrupts work gracefully. It does not kill the process.
- After a forced stop, Agent Sessions become Dormant. Their transcripts stay on disk.

If shutdown cannot finish before its deadline, Flow reports a failure and keeps ownership of the
state root.

- Do not start another Session Host against that state root.
- Examine `host.log`.
- Resolve the stalled operation before you try to recover.

## One host for each state root

Each `FLOW_STATE_DIR` permits one Session Host.

- A TUI attaches to an existing host. It does not stop that host when the TUI exits.
- If the TUI starts its own host, that host stops when the TUI exits.
- A one-shot prompt refuses a state root that another host occupies.

## Durability

The Session Host keeps transcripts and authorisation. A worker failure interrupts work. It does not
replay the work.

Each Agent Session has one directory, `sessions/<id>/`, with `meta.json` and an append-only
`transcript.jsonl`.

- Flow writes synchronously, before it notifies any client. A client must never see an event that
  a restart would lose.
- On restart, sessions that were running load as **Dormant**. Their transcripts are readable.
  Nothing runs and nothing is spent. The next message revives them. The `revive` protocol
  command revives them explicitly.
- If an unclean shutdown tears a turn, Flow closes that turn on load with `reason: "aborted"`.
- A half-written final line in `transcript.jsonl` is accepted. Parsing stops at the last good entry.

[docs/milestones.md](milestones.md#m2-durability-and-revive) explains these choices.

## Shells

A Shell is a terminal that the web client draws in one tab of a Dock. A Dock is the tabbed region
below or beside an Agent Session's transcript.

- A Shell needs a pty. The pty is the native addon `node-pty`, which `npm install` builds.
- If the host cannot load `node-pty`, it reports `shell: false` on `/api/config`. The web client then
  shows no Docks.
- The single executable cannot contain a native addon. It must find `node-pty` on disk. This works
  on the machine that built it. It does not work after you move the binary to a different machine
  (ADR 0008).
- In sandbox mode, a Shell opens in the session's VM. See [isolation.md](isolation.md#sandbox-mode).
