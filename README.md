# Flow

Flow runs coding-agent sessions. You can watch and control them from a terminal or a browser.

- **Local mode (v1)** — a Session Host daemon runs on loopback. A TUI and a web UI are equal clients.
- **Backends** — the Claude Agent SDK (on your own Claude subscription) and the pi SDK (for models
  that Claude does not serve). You choose the backend for each Agent Session.

[CONTEXT.md](./CONTEXT.md) defines the domain language. [docs/adr](./docs/adr) records the decisions.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Backends and credentials](#backends-and-credentials)
- [Everyday use](#everyday-use)
- [Where state lives](#where-state-lives)
- [Updating Flow](#updating-flow)
- [More documentation](#more-documentation)

## Requirements

- Node.js 22 or later, and npm. CI checks installs on Linux and macOS.
- A user-owned npm prefix, for example from a Node version manager. Do not use sudo or a shared
  system prefix.
- For filesystem isolation on Linux: Bubblewrap. See [docs/isolation.md](docs/isolation.md).

## Install

```bash
npm install --global @nathanstephenson/flow
flow --version
```

You do not need to build anything. The `prepack` script builds the CLI, the web client and the
Workflow runtime into the package.

## First run

Start the Session Host:

```bash
flow serve
```

`flow serve` stays in the foreground. It prints a web handoff URL
(`http://127.0.0.1:PORT/auth?token=…`). Open that URL once in your browser.
To use the terminal client, run `flow tui` in another terminal.

To run the Session Host in the background:

| Command | Action |
| --- | --- |
| `flow serve start` | Start a background Session Host. |
| `flow serve status` | Show the installed and running versions. |
| `flow serve stop` | Stop the Session Host. |
| `flow serve restart` | Restart a background Session Host with its saved settings. |

Stop and restart refuse active work unless you add `--force`.
[docs/operating-the-host.md](docs/operating-the-host.md) gives the full rules.

To reach Flow from another machine, read [docs/remote-access.md](docs/remote-access.md).

## Backends and credentials

Configure credentials for the Backend Adapter that you use.

- **Claude** — Flow uses your Claude subscription credentials. It does not need
  `ANTHROPIC_API_KEY`. From source, the Agent SDK finds its own copy of Claude Code. The single
  executable needs a separate Claude Code install
  (see [docs/development.md](docs/development.md#single-executable)).
- **pi** — pi keeps its own credential store. Run `pi`, then `/login`, before you start a pi
  session. Flow reads pi state from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).

## Everyday use

### Commands

| Command | Action |
| --- | --- |
| `flow serve [--port N] [--address HOST]` | Run the Session Host in the foreground. |
| `flow tui [--scope DIR] [--backend claude\|pi\|fake]` | Open the terminal client. It connects to a running host, or starts its own. |
| `flow list` | List Agent Sessions. |
| `flow import [--scope DIR]` | List the Claude Code conversations recorded in a directory. |
| `flow import ID [--scope DIR] [--view]` | Import one as an Agent Session. `--view` makes it read-only. |
| `flow [--session ID] [--scope DIR] [--backend B] [--model M] [--effort L] "<prompt>"` | Send one prompt, then exit. |
| `flow update [--force]` | Update Flow. See [Updating Flow](#updating-flow). |
| `flow --version` | Show the installed version. |

Examples:

```bash
flow --backend claude "Remember the word marmalade"          # prints a session id
flow --session <id> "What word did I ask you to remember?"   # → marmalade
flow list
```

Scope rules:

- `flow tui` without `--scope` uses the Project Root from `config.json`. If there is no Project
  Root, it uses the current directory.
- A one-shot prompt always uses the current directory, unless `--scope` names a different one.

### Agent Sessions survive restarts

When the Session Host restarts, sessions that were running load as **Dormant**. You can read their
transcripts. Nothing runs and nothing is spent. The next message revives a Dormant session.

### Importing Claude Code conversations

You can bring a conversation you had in Claude Code into Flow. In the web UI, open **New Agent
Session → Import** and choose a Project. From a terminal, run `flow import` in the directory where
you ran Claude Code. Flow lists only the conversations recorded in that directory.

- **Continue** brings the transcript and the conversation's context. The session starts Dormant,
  and your next message revives it where the conversation left off.
- **Read only** brings the transcript alone. The session is Ended: you can read it, but it does not
  revive.

Importing starts nothing and spends nothing. Flow copies only the conversation you choose, and Claude
Code's own copy is not changed. [ADR 0039](docs/adr/0039-agent-sessions-can-be-imported-from-claude-code.md)
explains the choices.

### Agent-to-agent communication

Parent agents can use `session_list` and `session_inspect` to discover Agent Sessions and read
bounded Presentation Transcript pages across this host. `session_create` starts independent work;
`session_send` sends an attributed message through the Steering Queue without interrupting a turn.
Creation and messaging use the existing permission policy and can incur Spend. Agents cannot answer
another Agent Session's human prompts. Use a fresh Worktree for concurrent edits, and inspect for
results rather than assuming delivery means completion.

### TUI keys

| Key | Action |
| --- | --- |
| `^S` | Sessions |
| `^P` | Models (grouped by provider) |
| `^E` | Effort |
| `esc` | Abort |
| `^C` | Quit |

If you type while the agent works, Flow queues the message. It does not interrupt the agent.
Steering is a deliberate action.

### Web UI

- The rail on the left lists Agent Sessions. One Agent Session shows in the main pane.
- To resize the rail, drag its right edge (180px to 520px). The browser remembers the width.
- To hide or show the rail, click that edge or press ⌘B / Ctrl-B. The open state is not
  remembered after a reload.
- When the edge handle has focus, the arrow keys resize the rail. Hold Shift for a larger step.
- To open **Settings**, click the gear at the bottom-left of the rail. Press `?` for the Keyboard
  section.

Settings, Projects, MCP connections and fonts are described in
[docs/configuration.md](docs/configuration.md). Git publishing and stacked pull requests are
described in [docs/git.md](docs/git.md).

## Where state lives

Flow keeps all state under one state root: `$FLOW_STATE_DIR`, default `~/.flow`.

| Path | Content |
| --- | --- |
| `sessions/<id>/meta.json`, `sessions/<id>/transcript.jsonl` | One directory for each Agent Session. The transcript is append-only. |
| `config.json` | Settings. See [docs/configuration.md](docs/configuration.md). |
| `token` | The daemon bearer token. It gives full access. Protect it. |
| `daemon.json` | The `{ url, token }` of the running Session Host. |
| `host.log` | Output of a background Session Host (private). |
| `mcp-credentials.json` | MCP OAuth credentials (private). |
| `oidc/` | OIDC tokens and browser sessions, when OIDC is on. |
| `sandbox-provider.json` | Optional sandbox provider file. See [docs/isolation.md](docs/isolation.md). |

Each state root permits one Session Host.

## Updating Flow

```bash
flow update
```

Before you update, close all CLI and TUI clients. Stop other Session Hosts that use this
installation. Updates are never automatic. [docs/updating.md](docs/updating.md) gives the
requirements, the browser update, systemd setup and the repair procedure.

## More documentation

| Page | Content |
| --- | --- |
| [docs/operating-the-host.md](docs/operating-the-host.md) | Background host, stop and restart rules, Shells |
| [docs/updating.md](docs/updating.md) | `flow update`, browser update, failure and repair |
| [docs/systemd-updates.md](docs/systemd-updates.md) | Updates for systemd-owned hosts |
| [docs/isolation.md](docs/isolation.md) | Filesystem isolation, Bubblewrap and sandboxes |
| [docs/remote-access.md](docs/remote-access.md) | Container access and the OIDC gate |
| [docs/configuration.md](docs/configuration.md) | Settings, MCP connections, Projects, fonts, environment variables |
| [docs/git.md](docs/git.md) | Publish branch names and stacked pull requests |
| [docs/workflow-builder-scope.md](docs/workflow-builder-scope.md) | Workflows, including direct MCP steps |
| [docs/development.md](docs/development.md) | Build, test, web development, releases |
| [docs/milestones.md](docs/milestones.md) | Project status and design notes from each milestone |
