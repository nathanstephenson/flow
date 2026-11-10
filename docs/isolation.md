# Filesystem isolation

Flow can limit what model work can do to the host filesystem. The policy and its limits are in
[ADR 0028](adr/0028-local-model-work-has-a-fail-closed-filesystem-boundary.md).

## Modes

Set the mode in **Settings → General → Filesystem isolation**. The setting is machine-wide.

| Stored `filesystemIsolation` | Effect |
| --- | --- |
| `"bubblewrap"` | Requires Linux Bubblewrap enforcement. |
| `"sandbox"` | Requires a sandbox VM. See [Sandbox mode](#sandbox-mode). |
| `"none"` | Unrestricted execution. |
| omitted | Automatic mode. |
| `true` / `false` (old files) | Load as `"bubblewrap"` / `"none"`. |

In all modes, Claude and pi Backend Sessions run in owned worker processes. Worker process
separation stays on. HTTP MCP and network access do not change.

### Automatic mode

- If a real Linux Bubblewrap launch check succeeds, automatic mode selects Bubblewrap.
- If enforcement is unsupported or unavailable, automatic mode selects **UNRESTRICTED**. This
  includes macOS, missing Bubblewrap and unavailable namespaces.
- Automatic mode never selects sandbox.
- The check must finish before automatic work starts.
- The first automatic choice stays fixed until the Session Host restarts. A failed launch never
  changes it to unrestricted.

The Settings group shows the support status, the reason, and a clear warning when execution is
unrestricted.

### When changes apply

A change applies to new Backend Sessions (including Revive), new Workflow Executions and new local
stdio MCP clients. It does not change existing work. Agent Workflow Steps use the policy of their
Backend Session.

## Bubblewrap mode

When isolation is on, Bubblewrap makes the host filesystem read-only. Only these locations are
writable:

- the selected Scope,
- dedicated backend state,
- private scratch space.

The boundary also covers:

- Subagents and Background Calls,
- local Workflow Shell and TypeScript steps,
- local stdio MCP servers.

One boundary covers the local supervisor, the QuickJS worker and all Shell descendants. Its
inherited PID namespace enforces cleanup, also for detached processes.

Local code steps need host Node 22 or later. The `workflowRuntime` Settings contain only an
optional absolute `nodePath` override.

### Install Bubblewrap

```bash
sudo apt install bubblewrap
```

Linux enforcement needs:

- Bubblewrap with descriptor-backed bind mounts (`--bind-fd` and `--ro-bind-fd`), which pin mount
  sources,
- working user, mount and PID namespaces.

After you install or repair enforcement, restart the Session Host. This refreshes the automatic
choice.

**An explicit enable fails closed.** If enforcement is unavailable, if a Scope is unsafe, or if a
restricted launch fails, Flow refuses the work. It never changes to unrestricted without telling
you.

## Unrestricted mode

When isolation is off, Scope is only a working directory.

- Agent tools, Shell commands and local stdio MCP servers can read, write or delete files
  elsewhere, as the host user. This includes credentials and Flow state.
- Detached processes are not contained by a PID namespace.
- QuickJS, closed compilation and scoped filesystem APIs still restrict direct TypeScript guest
  access. But Shell and the trusted Node supervisor have unrestricted host authority. There is no
  boundary that the OS enforces.

## Limits in all modes

- No mode protects Scope from damage.
- No mode fully controls hard links or other data aliases that existed before.

## Sandbox mode

Sandbox mode runs work in a VM. The VMs are Docker Sandboxes (`sbx`).

### Provider file

Sandbox mode needs a sandbox provider file. The Session Host reads it once, at startup, from:

1. the path in `FLOW_SANDBOX_PROVIDER`, or else
2. `<state root>/sandbox-provider.json`.

| Field | Content |
| --- | --- |
| `version` | `1` |
| `nodePath` | Absolute path of Node in the guest. |
| `claudePath` | Absolute path of Claude in the guest. |
| `claudeAuthDir` | Optional. Host folder that holds Claude's `.credentials.json`. |
| `probe` | Argv template. Sandbox is available only when `probe` exits with 0. |
| `create` | Argv template with `{spec}`, and optionally `{name}`. |
| `exec` | Argv template with `{name}` and `{cwd}`. |
| `remove` | Argv template with `{name}`. |
| `shell` | Optional argv template with `{name}` and `{cwd}`. Opens a Shell in the session's VM. |

- Flow adds `/bin/bash -l` to the `shell` template.
- Without `shell`, Flow refuses to open a Shell in sandbox mode.
- Flow mounts `claudeAuthDir` writable in the VM, so refreshed tokens stay on the host.
- For a harness `/login`, set `claudeAuthDir` to the absolute form of
  `~/.local/state/goodstack-ai-harness/<name>/claude`.

Example, with a base environment from `harness plan --out <dir>`:

```json
{
  "version": 1,
  "nodePath": "/usr/local/bin/node",
  "claudePath": "/home/agent/.local/bin/claude",
  "claudeAuthDir": "/Users/<you>/.local/state/goodstack-ai-harness/goodstack/claude",
  "probe": ["sbx", "ls", "--json"],
  "create": ["sbx", "env", "create", "<dir>", "{spec}", "--force"],
  "exec": ["sbx", "exec", "-i", "-w", "{cwd}", "{name}"],
  "remove": ["sbx", "rm", "--force", "{name}"],
  "shell": ["sbx", "exec", "-it", "-w", "{cwd}", "{name}"]
}
```

### Pi skills and prompts

Flow makes the host's Pi `skills` and `prompts` directories available read-only in the Sandbox.
It resolves symlink targets, so Git-managed configuration linked from `~/.pi/agent/skills` works
without copying it into the sandbox template. `PI_CODING_AGENT_DIR` overrides the host Pi directory.
Other user state, such as global transcripts, is not mounted with these resources. Workflow builders
do not load these ambient resources.

Existing Backend Sessions need to be Revived to pick up the mounts. Once mounted, changes within
the resource directories are visible when the Skills menu reloads. Repointing a symlink requires a
new Backend Session; a changed mount may also require releasing the Shared Sandbox's active holds.

### Sharing

The `sandboxSharing` Setting selects how many VMs Flow uses:

| Value | Effect |
| --- | --- |
| `"session"` (default) | One VM for each Agent Session. |
| `"shared"` | One VM for all sandbox sessions. It stays while the Session Host runs. Scopes must be under the Project Root or a Worktree. |

See [ADR 0034](adr/0034-a-shared-sandbox-serves-all-sandbox-sessions.md).

## Configuration API

- Omit the `filesystemIsolation` key from `config.json` to select automatic mode.
- PUT `/api/config` with `filesystemIsolation: null` resets to automatic mode.
- If a PUT omits the key, the current override does not change.
- The config view reports isolation status: the resolved `mode`, `automatic`, `checking`,
  Bubblewrap `supported` and `reason`, and `sandbox` support.
