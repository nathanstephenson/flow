# Configuration

## Settings

All Settings are in one file, `<state root>/config.json`. You can also edit them in the web UI
at **Settings**: click the gear at the bottom-left of the rail, or press `?` for the Keyboard
section.

Settings are machine-wide. They apply to every Agent Session on the machine, not to one Scope.

```json
{
  "retention": { "settled": "1d" },
  "fonts": {
    "chrome": "'Inter Variable', sans-serif",
    "monospace": "'MesloLGS NF', monospace"
  },
  "projects": {
    "root": "~/workspace",
    "include": ["work/api", "e2e", "/srv/elsewhere/thing"]
  }
}
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `filesystemIsolation` | `"bubblewrap"`, `"sandbox"` or `"none"`. See [isolation.md](isolation.md). | automatic |
| `sandboxSharing` | `"session"` or `"shared"`. See [isolation.md](isolation.md#sharing). | `"session"` |
| `workflowRuntime.nodePath` | Optional absolute path of Node for local Workflow code steps. | host Node |
| `retention.settled` | How long a Settled Agent Session stays before Flow deletes it. A duration (`90m`, `36h`, `1d`) or `never`. | `1d` |
| `fonts.chrome` | The interface typeface: labels, transcript prose, buttons. | `'Inter Variable', sans-serif` |
| `fonts.monospace` | The Shell's terminal, and the UI text that aligns character by character. | a Nerd Font stack ([Fonts](#fonts)) |
| `projects.root` | The Project Root: where Flow looks for Candidates, and where Flow opens. Absolute or `~`-relative. | none |
| `projects.include` | The Projects that you opted into. Each entry is relative to the Project Root, or absolute. | none |

You can omit any section. It then keeps its default.

### How Flow reads and writes the file

Flow reads the file **leniently** and writes it **strictly**.

- A typo on disk loses only its own value, which goes back to its default. Flow shows a warning at
  startup. A typo must not stop the daemon that owns your Presentation Transcripts.
- Flow refuses a value sent from the browser and names the field, because a person is there to fix
  it.

The Session Host reads the file through one owner (`src/daemon/config-store.ts`). It does not copy
values at startup. So an edit applies to the running daemon:

- retention applies at the next hourly sweep,
- a typeface applies immediately.

### Retention

If you shorten `retention.settled`, you arm a delete.

- Flow removes nothing when you save. The hourly sweep removes sessions within the hour.
- Before you save, the Settings page counts the Agent Sessions that the new window newly reaches.
  You must confirm.
- Flow deletes only Settled Agent Sessions. An Ended Agent Session stays on disk.

## MCP connections

Use **Settings → MCP** to add one of these:

- a local command and its arguments,
- a remote Streamable HTTP URL.

New Agent Sessions use a connection by default. To change that default, turn off its switch. The
New Agent Session page lets you choose the connections for that Agent Session.

### Changes and inheritance

- Revive keeps the selected IDs and uses the latest definitions.
- Edits and deletions do not change an open Backend Session.
- Subagents and Workflow Steps inherit the connections and the existing permission rules of their
  Backend Session.
- pi parent turns and ordinary Subagents still run tools without Flow Permission Prompts.

### Startup and Retry

Connection startup does not block Agent Session creation.

- The first model prompt and the first Workflow Step wait for bounded discovery and tool
  registration. They then continue, even if connections fail.
- The MCP status shows failures and a **Retry** control.
- Retry requires that no parent turn, Subagent, Background Call or Workflow Step is in progress.
- New model work waits until Retry finishes.

### OAuth

1. Select **Sign in**.
2. Complete the authorization.
3. Go back to Flow and select **Retry**.

- OAuth uses one machine-wide identity for each connection.
- Flow keeps the credentials apart from Settings, in `mcp-credentials.json`, with private file
  permissions.
- OAuth servers must support dynamic client registration.

Resources, prompts and the old HTTP+SSE transport are not supported.

For direct MCP calls from a Workflow, see
[workflow-builder-scope.md](workflow-builder-scope.md#mcp).

## Projects

A **Project** is a directory that you opted into, to start Agent Sessions from. It is a *candidate*
Scope, not a Scope. `projects.include` is the complete list.

A repository that Flow can see below the Project Root is a **Candidate** until you add it to the
list:

```
~/workspace                      projects.include        Offered in the dialog
├── work/
│   ├── api/.git      Candidate  → "work/api"            ✓  api        (under "work")
│   └── web/.git      Candidate                             –
├── mono/.git         Candidate  → "mono/packages/api"    ✓  api        (under "mono/packages")
│   └── packages/api             ↑ found by search, not offered as a Candidate
├── notes/                       → "notes"                ✓  notes  (not a repo)
└── old-thing/.git    Candidate                              –
```

A root usually holds many repositories that you do not work on today. So you choose the list.

### Build the list

Use **Settings → Projects**. There are three ways:

- **Candidates** — the repositories below the Project Root. Add each with one click.
  - A directory that holds a `.git` is a Candidate.
  - Flow never looks inside a repository, so `node_modules` and build output stay out without a
    blocklist.
  - The walk goes three levels deep. It skips hidden directories and symlinks.
- **Any directory** — a search field, for directories that the Candidate walk does not offer.
  - Type a **name** to fuzzy-match below the Project Root. This search goes *inside* repositories,
    so you can find `mono/packages/api`.
  - Start with `/` or `~` to complete a **path** anywhere on the machine. Use this for a Project
    outside the root.
  - Only the first character decides. So `work/api` is a name, and it narrows the search.
- **Project Root** — sets what the other two can see. If you clear it, your Projects stay. An
  absolute entry does not need it.

An opted-in directory does not have to be a repository. You chose it, so Flow does not guess.

If a directory in the list no longer exists, Flow **marks** the entry. It does not remove it,
because a hidden entry would look like a failed save.

### The New Agent Session dialog

- With no Projects, the dialog shows one prefilled Scope field.
- With one or more Projects, the dialog starts with a Project picker. The Scope field starts
  empty. `n` opens the dialog with the picker focused. Type `n`, a few letters, Enter, Enter to
  start a session in the correct repository.
- The Scope field stays editable, for a directory that you did not opt into.

### The CLI

- `flow tui` uses the Project Root when `--scope` is absent.
- A one-shot `flow "<prompt>"` does not. It runs *in* a directory, so that directory is the
  default. Use `--scope` to choose a different one.

## Fonts

**If your shell prompt uses Powerline, set `monospace` to a Nerd Font.**

- Powerline separators are Private Use Area codepoints, for example U+E0B0 (arrow) and U+E0A0
  (branch).
- No stock system font has them. Without a Nerd Font, they show as empty boxes.
- Flow bundles no font. It uses the fonts installed on the machine that shows the UI.
- The default stack lists common patched families first (`MesloLGS NF`, `JetBrainsMono Nerd Font`,
  `FiraCode Nerd Font`, `Hack Nerd Font`), then stock fonts. The browser uses the first one it
  finds.

The defaults are in `src/protocol/fonts.ts`, which is the only source. `web/src/index.css` repeats
them for the first frame. `test/fonts.test.ts` keeps the two the same.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `FLOW_STATE_DIR` | State root. Default `~/.flow`. Each state root permits one Session Host. |
| `FLOW_OIDC_ISSUER`, `FLOW_OIDC_CLIENT_ID`, `FLOW_OIDC_CLIENT_SECRET`, `FLOW_OIDC_PUBLIC_APP_URL` | OIDC gate. Set all four or none. See [remote-access.md](remote-access.md). |
| `FLOW_SANDBOX_PROVIDER` | Path of the sandbox provider file. See [isolation.md](isolation.md#provider-file). |
| `FLOW_CLAUDE_PATH` | Path of `claude`, for the single executable. Default: `claude` from `PATH`. |
| `PI_CODING_AGENT_DIR` | pi state directory. Default `~/.pi/agent`. |
| `FLOW_URL` | Session Host URL for `npm run dev`. See [development.md](development.md#web-client-development). |
| `FLOW_ASSETS`, `FLOW_E2E`, `FLOW_E2E_PI` | Optional test suites. See [development.md](development.md#tests). |
