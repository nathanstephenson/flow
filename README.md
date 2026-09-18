# Flow

Run and watch coding-agent sessions from a terminal or a browser, over more than one agent SDK.

- **Local mode (v1)** — a Session Host daemon on loopback, with a TUI and a web UI as equal clients.
- **Backends** — the Claude Agent SDK (on your own Claude subscription) and the pi SDK (for models
  Claude doesn't serve). Backend is chosen per Agent Session.

See [CONTEXT.md](./CONTEXT.md) for the domain language and [docs/adr](./docs/adr) for decisions.

## Install

Requires Node.js 22 or later and npm. Linux and macOS installs are checked in CI.

```bash
npm install --global @nathanstephenson/flow
flow --version
flow serve
```

Open the web handoff URL printed by `flow serve`, or run `flow tui` in another terminal.
Configure credentials for the Backend Adapter you use.

To check a release from source, run `npm ci` and `npm run test:package`.
This builds, packs, and installs the archive into a temporary prefix, then checks it
from an unrelated directory. Build outputs are not tracked in Git.

Maintainers can publish manually with `npm publish --access public` after release
approval and a license decision. The `prepack` script builds the CLI, web client,
and Workflow runtime; users do not need to build them.

## Publish branch names

Publish offers an editable branch name before the first push. It uses the Summary Model
when configured, with a local fallback otherwise. Confirmation creates a feature branch
from the default branch, or renames an unpublished branch. Published branches and registered
stack branches keep their names. No branch changes happen while preparing the review.

## Stacked pull requests

The browser's Git tab uses `github/gh-stack` directly (tested with v0.1.1).
Install it on the Session Host with `gh extension install github/gh-stack` and
authenticate with `gh auth login`. Ordinary Git controls remain available without it.

Stack supports Create, Add, Switch, Submit, Sync, and Rebase. Create is offered only
for a clear chain of at least two existing local branches linked by PR head/base relationships.
Commit ancestry alone does not identify a stack. Merged members retain their status.
Create registers the displayed branches; it never accepts names for new branches.
Ambiguous chains and branches already tracked in a stack are not offered.
Switching and mutations
require no working Agent Session in the same Scope, including background work.
Except for conflict continuation and abort, the working tree must be clean; Flow never
stashes changes. Use Publish for uncommitted files; stack branches use their active
parent as the review base and the base for new PRs. Switch only selects local stack
branches, including numeric branch names.

Submit and Sync require a fresh review of the affected branches and PRs. Submit uses
`gh stack submit --auto`: new PRs are drafts; existing draft states do not change.
Sync checks remote stack membership at review and confirmation, then fetches,
rebases, and pushes. If membership differs, reconcile it with `gh stack` outside
Flow and review again. API failures block Sync. The CLI cannot lock remote membership;
changes after the final check remain a race. After a Sync conflict, use Rebase to resolve it
locally, then confirm Sync again. No retry or push happens automatically.

A paused Rebase shows conflict files, Continue, and Abort. **Ask agent to fix, then
continue** sends a normal message to the current Agent Session to resolve and stage
conflicts, then use `gh stack rebase --continue` only when resolved. It does not grant
permission to publish, push, sync, or merge. Review the result and refresh Stack.
Merge and stack restructuring are not exposed.

**Copy stack** copies PR titles as formatted links, from top to bottom. **Copy PR link**
copies one PR. Plain-text paste contains titles only.

## Status

**M0 (walking skeleton) complete.** The Claude adapter drives real sessions end to end; the Session
Host, Presentation Transcript, and shared reducer are in place behind the Backend Adapter contract.

```bash
npm start -- --backend claude "Use Glob to list *.json here, then say DONE"
```

Verified along the way:

- **Spike 0** — the Agent SDK works on subscription credentials with no `ANTHROPIC_API_KEY`, and
  with every `CLAUDE*` variable scrubbed from the child environment (`spikes/subscription-auth.ts`).
- **Streaming input never self-initialises.** `query()` emits nothing until the input stream yields
  its first message, so a Backend Adapter must not await the init message before returning — it
  deadlocks. Capabilities therefore arrive late, via `capabilities_changed`.
- **`bypassPermissions` shadows `canUseTool`.** Pre-approved tools are expressed as
  `permissionMode: "default"` plus `allowedTools`, leaving `canUseTool` to handle the fall-through —
  where it raises a Permission Prompt for the human to decide (ADR 0018), or an Enquiry for
  `AskUserQuestion` (ADR 0016). The SDK warns that allowlisted tools skip the callback; that is the
  intent, not a misconfiguration, and it is why `bypassPermissions` would take away the only place a
  tool can be held open on a person. What must never happen is a callback that neither settles nor
  denies: that is a turn nobody can end.

**M1 (pi adapter) complete.** Both backends now sit behind the same Backend Adapter contract.

pi's real `AgentSessionEvent` union was read out of its type declarations with the compiler API
(`spikes/probe-type.ts`) rather than inferred, which corrected three things:

- **pi separates runs from turns.** `agent_start`/`agent_end` bracket one exchange with the human;
  `turn_start`/`turn_end` fire once per model call, many times inside it. Our `turn_started` /
  `turn_ended` map to `agent_*`. Mapping them to `turn_*` would emit N pairs per prompt.
- **`agent_end` carries `willRetry`.** When set, pi is about to auto-retry and the exchange is not
  over, so no `turn_ended` is emitted yet.
- The union has 17 members, including `compaction_start` and `thinking_level_changed`, which are not
  visible from how existing consumers use it.

`Capabilities.providers` earns its place: Claude reports `["anthropic"]`, pi reports 32.

pi keeps its own credential store, so live pi runs need `pi` + `/login`. The translation itself is
covered without credentials in `test/backend/pi-mapping.test.ts`, including a regression test that
we always send `streamingBehavior: "steer"` and never touch pi's native follow-up queue.

**M2 (durability and revive) complete.** Agent Sessions outlive the process that started them.

```bash
flow --backend claude "Remember the word marmalade"   # prints a session id
flow --session <id> "What word did I ask you to remember?"   # → marmalade
flow --list
```

Transcripts live at `$FLOW_STATE_DIR` (default `~/.flow`), one directory per Agent
Session: `meta.json` plus append-only `transcript.jsonl`. Writes are synchronous and happen before
any client is notified — a client must never see an event a restart would lose.

- On restart, previously running sessions load as **Dormant**: transcripts readable, nothing
  running, nothing spent. The next message revives them, or `revive` does it explicitly.
- A turn torn by an unclean shutdown is **closed on load** with `reason: "aborted"`. The transcript
  is append-only, so we record that we now know it ended rather than rewriting it.
- Dormancy is an event (`session_dormant`), not just host state. Without it a client reducing the
  transcript sees `turn_ended` and shows a ready prompt for a session with no backend attached.
- A half-written final line in `transcript.jsonl` is tolerated: parsing stops at the last good entry.

Claude's `resumeDropsTurn` takes a message id rather than a boolean, so there is no generic
"drop the torn turn" hint to pass down; the torn turn is closed in our transcript instead.

**M3 (transport and TUI) complete.** The terminal client talks to the Session Host over the wire,
never to a session object.

```bash
flow serve          # Session Host on 127.0.0.1, prints the web handoff URL
flow tui            # terminal client; connects to a running host or embeds one
flow list
```

TUI keys: `^S` sessions · `^P` models (grouped by provider) · `^E` effort · `esc` abort · `^C` quit.
Typing while the agent works queues the message rather than interrupting it — steering is a
deliberate act.

Transport is POST for commands and SSE for events. SSE rather than WebSocket because the transcript
is one-directional and sequence-numbered, so reconnect is `?since=N` — a replay, not a
resynchronisation protocol — and it needs no dependency in Node or the browser.

Two bugs the tests caught that a manual try would likely have missed:

- **A stdin chunk is not a keystroke.** A paste arrives as one chunk and an arrow key as a
  three-byte escape sequence, so chunks are tokenised into keys.
- **Chunk handlers raced.** Key handling is async, so a chunk arriving mid-walk interleaved with the
  previous one and applied keys out of order. Chunks are now processed strictly in sequence.

**M4 (web UI) complete.** A richer surface than the TUI, on the same transport and the same reducer.

```bash
flow serve   # prints http://127.0.0.1:PORT/auth?token=… — open that once
flow serve --port 3000 --address 0.0.0.0   # containers reached via a published port
```

Several Agent Sessions on screen at once, collapsible tool calls, file edits rendered as diffs,
per-pane transcript search, provider-grouped model picker, Steering Queue depth and context usage —
the surface M6 rebuilds, one Agent Session on screen at a time.

The browser ran **the same reducer as the TUI**, not a copy: `src/client/reduce.ts` and
`src/client/diff.ts` imported only types, so stripping left standalone ESM with no imports — served
as `/reduce.js` and `/diff.js`, no bundler — and a test loaded what the Session Host actually served
and asserted it produced state identical to the TypeScript reducer. **Superseded by M6**, which has
the browser import the reducer instead of being handed it.

Assets are served from a manifest held in memory, so a single-executable build has nothing to find on
disk at runtime. Nothing generated is committed: `src/web/embedded.ts` exports an empty manifest that
`npm run build:binary` replaces at bundle time, and a source run builds `web/dist` (`prestart`) and
reads it through the same `manifestOf()` the binary build uses (ADR 0017). Starting without a build
is refused rather than silently serving nothing.

The `/auth` handoff exists because a browser cannot put an `Authorization` header on a navigation or
an `EventSource`: the token goes into an HttpOnly cookie once, and the UI itself — not just the API
— requires it. An externally reachable personal deployment should use the OIDC gate below instead.

### External OIDC gate

Flow can delegate browser admission to any standards-compliant OpenID Provider while preserving the
bearer header used by CLI/TUI clients. This is a **shared personal deployment**, not multi-user
isolation: every person admitted by the issuer has full access to every Agent Session, Shell, file,
secret and Setting the daemon can reach.

Configure all four variables or none. Partial or invalid configuration fails before the daemon
listens; unconfigured deployments keep the local `/auth?token=…` behaviour.

```bash
export FLOW_OIDC_ISSUER=https://id.example.com
export FLOW_OIDC_CLIENT_ID=flow
export FLOW_OIDC_CLIENT_SECRET='replace-me'
export FLOW_OIDC_PUBLIC_APP_URL=https://flow.example.com
flow serve --port 4318                       # keep loopback when the proxy is on this host
# or --address 0.0.0.0 in an isolated container network
```

Register these URLs at the issuer:

- redirect URI: `https://flow.example.com/oauth/callback`
- back-channel logout URI: `https://flow.example.com/oauth/backchannel`

The issuer must support OIDC discovery, Authorization Code, a confidential client authentication
method (`client_secret_basic` or `client_secret_post`), signed ID tokens, S256 PKCE, refresh tokens,
and the `openid` scope. Flow requests `offline_access`. Back-channel logout is optional but required
for immediate revocation when the issuer disables a user; discovery alone cannot report an account
change. Logout inside Flow does not perform global issuer logout.

Terminate HTTPS at the reverse proxy and forward `/`, `/api`, `/assets` and `/oauth` to the daemon,
including HTTP upgrade for Shell WebSockets and streaming responses for SSE. `FLOW_OIDC_PUBLIC_APP_URL`
is the only browser origin Flow trusts in this mode. Do not rewrite it from request headers and do
not expose the daemon directly; Flow intentionally ignores `Forwarded` and `X-Forwarded-*` for its
security decisions. HTTP issuer/app URLs are accepted only for `localhost`, `127.0.0.1` or `::1`
development.

Provider tokens remain server-side. Flow persists them and opaque browser sessions under
`$FLOW_STATE_DIR/oidc/` (0700 directory, 0600 file, with no additional application-level encryption),
rotates refresh tokens, coordinates concurrent refreshes, and applies a seven-day absolute
browser-session lifetime. Flow logout, expiry, failed
refresh and valid back-channel notifications revoke the browser session and close its SSE/WebSocket
connections without ending Agent Sessions.

The daemon bearer token remains an explicit administrative bypass:

```bash
curl -H "Authorization: Bearer $(cat "$FLOW_STATE_DIR/token")" \
  https://flow.example.com/api/sessions
```

A bearer client does not enter OIDC and works remotely when the reverse proxy forwards the header.
Protect that token as full app access. In OIDC mode `/auth` is disabled and an old `flow=` cookie is
ignored, so the bypass cannot be handed to a browser through Flow.

A reproducible local Provider is included for integration testing:

```bash
npm run test:oidc-issuer -- http://127.0.0.1:5173
# In another terminal, export the four variables it prints, start Flow on :4318, then `npm run dev`.
```

It performs discovery, S256 PKCE, confidential client authentication, signed ID/logout tokens and
refresh-token rotation. It auto-admits one fixed test subject and is for localhost testing only.
Nathan's separate OpenAuth-based issuer has not been compatibility-verified by this change.

**M5 (single executable) complete.** `npm run build:binary` produces `build/flow`: an esbuild
bundle injected into a copy of the `node` binary via Node SEA.

**Claude Code is a prerequisite for the binary, not a payload.** The Agent SDK spawns the CLI as a
child process, and a child needs a real file on disk, which a SEA blob cannot provide. Install it
separately (`npm i -g @anthropic-ai/claude-code`); the binary resolves `claude` from PATH, or from
`FLOW_CLAUDE_PATH`. Running from source is unaffected — the SDK finds its own copy.

Building on macOS additionally needs Xcode command line tools: injection invalidates the `node`
binary's code signature, so the build strips it, injects into a `NODE_SEA` Mach-O segment, then
re-signs ad hoc. Without that the kernel SIGKILLs the binary at launch and prints only `killed`.

Five things the build needed:

- **`import.meta.url` becomes `undefined` in a CommonJS bundle**, which breaks the
  `createRequire(import.meta.url)` calls inside bundled dependencies. The build defines it as a real
  file URL.
- **pi is loaded lazily** (`src/backend/registry.ts`). It is ESM-only and pulls in native and wasm
  packages, so a bundle cannot require it at startup. On demand, its absence is a clear error when
  you ask for a pi session rather than a crash at launch — the binary is Claude-only unless pi is
  installed alongside it.
- **The CLI is spawned directly, not through `process.execPath`.** The SDK runs the CLI as
  `<node> <cli-path> …` using `process.execPath` as the interpreter — but inside a single executable
  that *is* the Flow binary, so the spawn re-invokes Flow with the CLI's arguments,
  argument parsing rejects them, and it surfaces as `Claude Code process exited with code 1`. A
  `spawnClaudeCodeProcess` override executes the CLI path itself. It rewrites *only* interpreter
  spawns: a native Claude Code install is spawned with no interpreter at all, so the binary is
  already the command and `args[0]` is a real flag. Hoisting it there executes `--output-format` as
  a program, and the SDK reports that as "native binary exists but failed to launch — probably a
  libc mismatch", which is not what went wrong.
- **Native `esbuild`, after a spell on `esbuild-wasm`.** The wasm build was chosen to keep the
  lockfile portable: the native package resolves to a per-platform binary, so one installed on macOS
  looked as though it would leave the Linux build broken. It never would have — `package-lock.json`
  is lockfileVersion 3 and records every platform's optional binary rather than the host's, as it
  already did for both agent SDKs and now does for M6's Rolldown and lightningcss bindings too, and
  `npm ci` picks the right one per OS. The shim was defending a property the tree does not have, at
  the price of shipping two esbuilds. The switch produced a byte-identical bundle and took
  `logLevel: "silent"` with it — that existed only because the wasm stdio shim threw writing its own
  summary to a pipe, and the native package writes nothing there at all.
- **The packaging asymmetry held**, exactly backwards from intuition: pi is in-process and would
  bundle cleanly if not for its native deps, while Claude — the one that looks like a library — is
  the one needing an external executable.

**M6 (the web client is bundled) in progress.** The browser client is a Vite and React application
in `web/`, and it *imports* `src/client/reduce.ts` as TypeScript rather than being served that file
with its types stripped.

M4's arrangement is reversed deliberately. Importing the reducer makes two copies of it impossible
for the compiler's reasons rather than a test's, and it lifts the ceiling that arrangement imposed:
nothing shared could import a value, which is why `src/client/diff.ts` compares lines naively. So
`src/client/` stops being only the shared reducer and becomes the shared front-end core — reducer,
transport, and the presentation logic both clients need — under a standing rule that everything in
it stays free of DOM types, because the TUI compiles it under a program that has none.

The Session Host learns nothing about Vite. `prebuild:binary` builds `web/dist` and the binary build
turns it into the manifest it injects; the rest of the chain is untouched. What the host gained is a
manifest instead of six hard-coded files: content-hashed assets served
`public, max-age=31536000, immutable`, the Entry Document `no-store` — which is doing real work,
since an immutably cached one would pin a browser to a deleted asset hash — and a fallback that
answers an unknown path with the Entry Document so a deep-linked Agent Session survives a reload,
with `/api` and `/assets` excluded, because a missing hashed chunk answered with HTML costs an hour
to diagnose.

The cost is that drift changes shape rather than going away. Two gates stand in for the test that
used to execute the served bytes: the build refuses to emit a bundle whose module graph lacks the
shared client modules, and `test/assets-embedding.test.ts` holds the manifest generator to the
content types, the base64 boundary and the `immutable` rule the host assumes. Staleness itself is
not among them, because the manifest is generated by the build that embeds it and cannot lag the
sources it was built from. Nothing typechecks the embedded bytes any more either — they are
`JSON.stringify` of a plain object, and the generator is what is tested instead.

The UI is master–detail: a sidebar of Agent Sessions and exactly one of them focused in a pane, where
M4 opened a pane per Agent Session. One at a time is the design rather than a limitation of it — the
rail carries the state of the others, banded most alive first, and a dot, a Subagent count, a queue
depth and a relative time per row is enough to monitor any number of them without reading them. Ten modules are
shared with the terminal client rather than the three the old arrangement allowed, so the model and
Effort pickers, the status predicates, transcript search and the relative clock are now one
implementation each instead of two that had already drifted. Styling is stock shadcn/ui on Base UI
primitives, with no bespoke palette to learn: the six states an Agent Session can be in are mapped
onto shadcn's own chart tokens, and monospace is kept only where character alignment carries meaning
— transcript text, tool output, diffs and Scope paths.

Nothing automatically proves the shipped bundle renders. The compiler, the module-graph check and the
hash all prove things about the bundle rather than about the app working, and closing that gap needs
a browser-driven smoke test that is designed but deferred.

## Development

```bash
npm install
npm run typecheck   # four programs: host, web presentation logic, web app, its Vite config
npm test
npm run spike:auth   # re-verify subscription auth
npm run test:oidc-issuer -- http://127.0.0.1:5173  # local standards test Provider

FLOW_ASSETS=1 npm test    # adds a Vite build, to prove the embedder handles everything it emits
FLOW_E2E=1 npm test       # adds the live Claude contract (spends tokens)
FLOW_E2E_PI=1 npm test    # adds the live pi contract (needs pi credentials)
```

All three stay out of the default loop for the same reason: `npm test` should need no credentials,
no network and no bundler, so a fresh clone with no `web/dist` — and an `--omit=dev` install with no
Vite at all — still runs it green. That holds by construction now rather than by care: no test
reaches a build output, and the ones about serving a web client are handed a fixture
(`test/assets-fixture.ts`).

### The rail

Drag its right edge to resize — 180px to 520px, remembered per browser in `localStorage`. Click that
same edge, or press ⌘B / Ctrl-B, to hide it entirely and give the Presentation Transcript the width.
The handle takes arrow keys when focused (Shift for a coarser step), because a drag handle that only
answers to a pointer is unusable without one.

The drag deliberately does not go through React: it writes `--sidebar-width` onto the provider
wrapper and commits to state once, on release. Routing it through state re-rendered the rail and the
transcript once per frame, and shadcn's own `transition-[width] duration-200` — which the open/close
slide needs — made the rail chase the pointer two frames behind. `data-resizing` on the wrapper
suppresses that transition for the length of the gesture and nothing else.

The width is remembered; whether the rail is open is not. Reloading into an app with no visible
navigation is a bad first frame, and hiding the rail is a momentary "give me the width" rather than a
preference — so it is browser state either way and never a Setting, which would make a laptop and a
desktop fight over one number.

⌘B is what shadcn's Sidebar binds and the muscle memory is worth matching, but it is resolved by
`web/src/presentation/bindings.ts` like every other key rather than by the component's own `window`
listener, which is removed. See the FLOW note in `web/src/components/ui/sidebar.tsx`.

### Settings

Everything configurable lives in one file, `<stateRoot>/config.json`, and is editable from the web
UI at **Settings** — the gear at the bottom-left of the rail, or `?` for the Keyboard section.
Settings are machine-wide: they govern every Agent Session on the machine, not one Scope.

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
| `retention.settled` | How long a Settled Agent Session survives before it is reaped. A duration — `90m`, `36h`, `1d` — or `never`. | `1d` |
| `fonts.chrome` | The interface typeface: labels, transcript prose, buttons. | `'Inter Variable', sans-serif` |
| `fonts.monospace` | The Shell's terminal, and the chrome that aligns character by character. | a Nerd Font stack (below) |
| `projects.root` | The Project Root: where Candidates are looked for, and what Flow opens on. Absolute or `~`-relative. | none |
| `projects.include` | The Projects, opted into. Each entry is relative to the Project Root, or absolute. | none |

Any section may be omitted and keeps its default. The file is read **leniently** and written
**strictly**, deliberately: a typo on disk costs only its own default and warns on startup, because
it must not stop the daemon that owns your Presentation Transcripts from starting — whereas a value
sent from the browser is refused with the field named, because there is someone waiting who can fix
it. The Session Host reads the file through one owner (`src/daemon/config-store.ts`) rather than
copying values at startup, so an edit applies to the running daemon: retention takes effect at the
next hourly sweep, and a typeface immediately.

Shortening `retention.settled` arms a delete. Nothing is removed on save — the sweep does it, within
the hour — but the Settings page counts the Agent Sessions the new window newly reaches and makes you
confirm before saving. Only Settled Agent Sessions are ever reaped; an Ended one stays on disk.

#### MCP connections

Use **Settings → MCP** to add a local command and its arguments, or a remote Streamable HTTP URL.
Connections are selected by default for new Agent Sessions; turn off the switch to change that default.
The New Agent Session page lets you choose the connections for that Agent Session.

Revive keeps the selected IDs and uses the latest definitions. Edits and deletions do not change an
open Backend Session. Subagents and Workflow Steps inherit its connections and existing permission
rules. Pi parent turns and ordinary Subagents still run tools without Flow Permission Prompts.

Connection startup does not block Agent Session creation. The first model prompt and Workflow Step
wait for bounded discovery and tool registration, then proceed even if connections fail. Its MCP
status shows failures and **Retry**. Retry requires no parent turn, Subagent, Background Call, or
Workflow Step in flight; new model work waits until Retry finishes.
For OAuth, select **Sign in**, complete authorization, then return to Flow and select **Retry**.
OAuth uses one machine-wide identity per connection. Credentials are kept separately from Settings
in `mcp-credentials.json` with private file permissions. OAuth servers must support dynamic client
registration. Resources, prompts, and legacy HTTP+SSE are not supported.

#### Projects

A **Project** is a directory you have opted into starting Agent Sessions from — a *candidate* Scope,
not a Scope. `projects.include` is the list, and it is the whole of it. A repository Flow can
see beneath the Project Root is a **Candidate** until it appears there:

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

Curation is the point: a root full of repositories is mostly repositories you are not working on
today. Settings → **Projects** is where the list is built, three ways:

- **Candidates** — the repositories found beneath the Project Root, one click each. Found by the
  same walk as before: a directory holding a `.git` is a Candidate, a repository is never looked
  inside (so `node_modules` and build output stay out with no blacklist), three levels deep, hidden
  directories and symlinks skipped.
- **Any directory** — a search field, because the useful directory is often one no Candidate walk
  would offer. Type a **name** and it fuzzy-matches beneath the Project Root, *reaching inside*
  repositories, which is how `mono/packages/api` is reachable at all. Start with `/` or `~` and it
  completes a **path** anywhere on the machine instead — that is the escape hatch for a Project
  outside the root. The rule is the first character, so `work/api` is still a name, and narrows.
- **Project Root** — what the other two can see. Clearing it does not clear your Projects; an
  absolute entry does not need it.

An opted-in directory need not be a repository, because you chose it deliberately and nothing has to
guess whether you meant it. An entry whose directory has since gone is **marked**, not dropped —
silently hiding it would look identical to the Setting having failed to save.

Until something is opted in there are no Projects, so the New Agent Session dialog behaves as it
did before this existed: one prefilled Scope field. Once there is at least one, the dialog leads
with a Project picker, the Scope field starts empty, and `n` opens with the picker focused — so `n`,
a few letters, Enter, Enter starts a session in the right repository. The Scope field stays
editable throughout, for the directory you did not opt in.

`flow tui` uses the Project Root when `--scope` is absent. A one-shot
`flow "<prompt>"` does not: it is run *in* a directory, so that directory is the right
default and `--scope` is how you say otherwise.

#### Fonts

**Set `monospace` to a Nerd Font if your prompt is a Powerline one.** Those separators are Private
Use Area codepoints — U+E0B0 for the arrow, U+E0A0 for the branch — and no stock system font carries
them, so a shell prompt that uses them renders as tofu until the terminal is told a font that has
them. Nothing is bundled: the right font is whichever is already installed on the machine doing the
reading, so the default stack names the common patched families (`MesloLGS NF`,
`JetBrainsMono Nerd Font`, `FiraCode Nerd Font`, `Hack Nerd Font`) ahead of the stock ones and picks
whichever it finds. The defaults live in `src/protocol/fonts.ts`, which is the only copy —
`web/src/index.css` restates them for the first frame and `test/fonts.test.ts` holds the two
together.

A Shell — a terminal the web client draws in one tab of a Dock, the tabbed region below an Agent
Session's transcript or beside it — needs a pty, which is a native addon. `npm install` builds it,
and where it cannot be loaded the host reports `shell: false` on `/api/config` and the web client
offers no Docks at all rather than a picker with nothing in it. A SEA blob cannot contain a native addon, so the binary from `npm run build:binary` has to
find `node-pty` on disk: it will on the machine that built it, and will not once shipped elsewhere,
where it reports `shell: false` and serves no Shells (ADR 0008).

Working on the web client means a Session Host to talk to, so start the host first:

```bash
npm start -- serve --port 4318   # terminal one: the Session Host
npm run dev                      # terminal two: Vite on 127.0.0.1:5173
```

The dev server finds the host through `daemon.json`, or `FLOW_URL` if you set it, and it
resolves that target once at startup — which is why the host wants a fixed `--port` rather than the
ephemeral one it picks by default. It proxies `/api`, `/auth` and `/oauth` through, so the browser stays on
one origin; that single origin is what lets the Session Host go on checking `Origin` strictly with
no CORS.

Do the cookie handoff on **the URL the dev server prints**, not the one the host prints.
`localhost`, `127.0.0.1` and `[::1]` are three different cookie hosts on one machine, so a cookie
taken on the host's is not sent to the dev origin, which then answers 401. And `/auth` redirects to
a relative `/` — which is what makes it work through a proxy at all — so following the host's own
URL lands you on the built client rather than on the dev server, with none of your unbuilt changes
in it.

Do not install with `npm ci --omit=optional`. Rolldown, lightningcss and esbuild all resolve their
native bindings through optional dependencies, so omitting them installs cleanly and then fails at
build time with an unhelpful "cannot find native binding".

CI (`.github/workflows/ci.yml`) runs the typecheck, the tests and the binary build. There is no
rebuild-and-diff step, because nothing generated is committed; the binary build is what proves the
web client can still be built and embedded.

Sources under `src/`, `test/` and `web/src/presentation/` are run through Node's
`--experimental-strip-types`, so TypeScript there is limited to erasable syntax: no parameter
properties, enums, or namespaces. Relative imports carry the `.ts` extension and are rewritten on
build. The rest of `web/` is Vite's and free of that constraint — but `src/client/**` is not,
however browser-facing it becomes, because the TUI still runs it stripped.

### Direct MCP Workflow Steps

In **Settings → Workflows**, choose **Add MCP**, select an Agent Session and one of its enabled
MCP servers, then **Discover tools**. Select the original tool name and compose its arguments using
literals and available workflow-input/predecessor references. The editor provides JSON Schema
fields, local references, alternatives, conditional/dependent fields, arrays/tuples and additional
properties, with the original constraints available for inspection. Validation uses the original
schema, not a reduced visual approximation. Unknown dialects, formats or validation keywords fail
explicitly; no constraint is silently discarded. Supported dialects are draft-07, 2019-09 and
2020-12 (the MCP default).

Direct steps support both stdio and Streamable HTTP, including existing OAuth sign-in. They make
no model call, create no Subagent and add no model tokens. Code-runtime sandbox settings do not
apply: a stdio server runs as the host user, and HTTP calls use the configured remote service.
Credentials belong in MCP Settings, never in workflow arguments. Expired/missing authentication
requires signing in there and a manual Retry; executions never launch a login flow or replay an
HTTP tool request after a 401.

The result is always `{ structuredContent: JSON | null, content: MCPContentBlock[] }`. Absent
structured content becomes null; text is not parsed as JSON, and links are not downloaded.
Map `structuredContent` (or its fields) into an Agent's input to review it directly. Successful
empty/not-found data stays successful and can drive a Branch. Tool errors retain bounded,
credential-redacted partial output. Results exceeding **100,000 UTF-8 bytes** fail without truncation.

Each execution pins connection configuration, server identity and original input/output schemas.
Changing the definition or reconfiguring a server never retargets an existing execution. Discovery
and each attempt revalidate these identities. Missing, disabled, changed or unauthenticated tools
require explicit reconfiguration rather than a fallback.

Ask mode prompts privately before **every call**, including single-step tests; auto-accept does not
prompt. The timeout defaults to **60 seconds**, configurable on the step. Existing failure/timeout
edges, loops, joins, Retry and Supply output work as for other steps. **Cancellation is not rollback:**
interrupted or timed-out writes may already have happened. Inspect the remote state before retrying.
See [the direct MCP execution decision](docs/adr/0025-direct-mcp-workflow-steps.md).
