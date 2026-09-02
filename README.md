# GoodHarness

Run and watch coding-agent sessions from a terminal or a browser, over more than one agent SDK.

- **Local mode (v1)** — a Session Host daemon on loopback, with a TUI and a web UI as equal clients.
- **Backends** — the Claude Agent SDK (on your own Claude subscription) and the pi SDK (for models
  Claude doesn't serve). Backend is chosen per Agent Session.

See [CONTEXT.md](./CONTEXT.md) for the domain language and [docs/adr](./docs/adr) for decisions.

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
  `permissionMode: "default"` plus `allowedTools`, leaving `canUseTool` to deny-with-reason on the
  fall-through so a stray tool cannot stall a turn. The SDK warns that allowlisted tools skip the
  callback; that is the intent, not a misconfiguration.

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
goodharness --backend claude "Remember the word marmalade"   # prints a session id
goodharness --session <id> "What word did I ask you to remember?"   # → marmalade
goodharness --list
```

Transcripts live at `$GOODHARNESS_STATE_DIR` (default `~/.goodharness`), one directory per Agent
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
goodharness serve          # Session Host on 127.0.0.1, prints the web handoff URL
goodharness tui            # terminal client; connects to a running host or embeds one
goodharness list
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
goodharness serve   # prints http://127.0.0.1:PORT/auth?token=… — open that once
goodharness serve --port 3000 --address 0.0.0.0   # containers reached via a published port
```

Several Agent Sessions on screen at once, collapsible tool calls, file edits rendered as diffs,
per-pane transcript search, provider-grouped model picker, Steering Queue depth and context usage —
the surface M6 is rebuilding.

The browser ran **the same reducer as the TUI**, not a copy: `src/client/reduce.ts` and
`src/client/diff.ts` imported only types, so stripping left standalone ESM with no imports — served
as `/reduce.js` and `/diff.js`, no bundler — and a test loaded what the Session Host actually served
and asserted it produced state identical to the TypeScript reducer. **Superseded by M6**, which has
the browser import the reducer instead of being handed it.

Assets are embedded as strings in `src/web/assets.generated.ts` (`npm run build:assets`), so the
host never reads them from disk and a single-executable build has nothing to find at runtime. That
module is a build output which is nevertheless committed, because the host imports it statically and
a fresh clone has to typecheck before anyone has run a bundler — so what stops it going stale is
load-bearing, and M6 is where it grew teeth.

The `/auth` handoff exists because a browser cannot put an `Authorization` header on a navigation or
an `EventSource`: the token goes into an HttpOnly cookie once, and the UI itself — not just the API
— requires it.

**M5 (single executable) complete.** `npm run build:binary` produces `build/goodharness`: an esbuild
bundle injected into a copy of the `node` binary via Node SEA.

**Claude Code is a prerequisite for the binary, not a payload.** The Agent SDK spawns the CLI as a
child process, and a child needs a real file on disk, which a SEA blob cannot provide. Install it
separately (`npm i -g @anthropic-ai/claude-code`); the binary resolves `claude` from PATH, or from
`GOODHARNESS_CLAUDE_PATH`. Running from source is unaffected — the SDK finds its own copy.

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
  that *is* the GoodHarness binary, so the spawn re-invokes GoodHarness with the CLI's arguments,
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

The Session Host and the single-executable build learn nothing about Vite. `prebuild:binary`
regenerates `src/web/assets.generated.ts` and the rest of the chain is untouched. What the host
gained is a manifest instead of six hard-coded files: content-hashed assets served
`public, max-age=31536000, immutable`, the shell `no-store` — which is doing real work, since an
immutably cached shell would pin a browser to a deleted asset hash — and a fallback that answers an
unknown path with the shell so a deep-linked Agent Session survives a reload, with `/api` and
`/assets` excluded, because a missing hashed chunk answered with HTML costs an hour to diagnose.

The cost is that drift changes shape rather than going away. The generated module is a committed
build output, so it can have been built from last week's reducer and nothing at runtime would
notice. Three gates stand in for the test that used to execute the served bytes: the build refuses
to emit a bundle whose module graph lacks the shared client modules; the generated module carries a
sha256 over every input — `src/client/**` and the lockfile included — that `npm test` recomputes, so
editing the reducer without rebuilding fails the suite; and CI rebuilds and refuses a dirty diff,
the only one of the three that does not depend on remembering a command. The embedded module grows
from 28 kB to 526 kB — under half a percent of the binary, but comfortably the largest file in the
tree.

The UI is master–detail: a sidebar of Agent Sessions, one in focus, and an opt-in two-up split where
M4 opened a pane per Agent Session. Ten modules are shared with the terminal client rather than the
three the old arrangement allowed, so the model and Effort pickers, the status predicates, transcript
search and the relative clock are now one implementation each instead of two that had already
drifted. Styling is stock shadcn/ui on Base UI primitives, with no bespoke palette to learn: the five
states an Agent Session can be in are mapped onto shadcn's own chart tokens, and monospace is kept
only where character alignment carries meaning — transcript text, tool output, diffs and Scope paths.

Nothing automatically proves the shipped bundle renders. The compiler, the module-graph check and the
hash all prove things about the bundle rather than about the app working, and closing that gap needs
a browser-driven smoke test that is designed but deferred.

## Development

```bash
npm install
npm run typecheck   # four programs: host, web presentation logic, web app, its Vite config
npm test
npm run spike:auth   # re-verify subscription auth

GOODHARNESS_ASSETS=1 npm test    # adds a Vite rebuild, to prove the embedded module is its output
GOODHARNESS_E2E=1 npm test       # adds the live Claude contract (spends tokens)
GOODHARNESS_E2E_PI=1 npm test    # adds the live pi contract (needs pi credentials)
```

All three stay out of the default loop for the same reason: `npm test` should need no credentials,
no network and no bundler, so a fresh clone with no `web/dist` — and an `--omit=dev` install with no
Vite at all — still runs it green.

Working on the web client means a Session Host to talk to, so start the host first:

```bash
npm start -- serve --port 4318   # terminal one: the Session Host
npm run dev                      # terminal two: Vite on 127.0.0.1:5173
```

The dev server finds the host through `daemon.json`, or `GOODHARNESS_URL` if you set it, and it
resolves that target once at startup — which is why the host wants a fixed `--port` rather than the
ephemeral one it picks by default. It proxies `/api` and `/auth` through, so the browser stays on
one origin; that single origin is what lets the Session Host go on checking `Origin` strictly with
no CORS.

Do the cookie handoff on **the URL the dev server prints**, not the one the host prints.
`localhost`, `127.0.0.1` and `[::1]` are three different cookie hosts on one machine, so a cookie
taken on the host's is not sent to the dev origin, which then answers 401. And `/auth` redirects to
a relative `/` — which is what makes it work through a proxy at all — so following the host's own
URL lands you on the embedded bundle rather than on the dev server.

Do not install with `npm ci --omit=optional`. Rolldown, lightningcss and esbuild all resolve their
native bindings through optional dependencies, so omitting them installs cleanly and then fails at
build time with an unhelpful "cannot find native binding".

CI (`.github/workflows/ci.yml`) runs the typecheck, the tests and the binary build, and rebuilds the
embedded assets to fail if the committed module moves.

Sources under `src/`, `test/` and `web/src/presentation/` are run through Node's
`--experimental-strip-types`, so TypeScript there is limited to erasable syntax: no parameter
properties, enums, or namespaces. Relative imports carry the `.ts` extension and are rewritten on
build. The rest of `web/` is Vite's and free of that constraint — but `src/client/**` is not,
however browser-facing it becomes, because the TUI still runs it stripped.
