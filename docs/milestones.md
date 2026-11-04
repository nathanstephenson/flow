# Milestones

This page records the status of each milestone, and what each one taught. For current use, read
the [README](../README.md).

| Milestone | Status |
| --- | --- |
| [M0 walking skeleton](#m0-walking-skeleton) | Complete |
| [M1 pi adapter](#m1-pi-adapter) | Complete |
| [M2 durability and revive](#m2-durability-and-revive) | Complete |
| [M3 transport and TUI](#m3-transport-and-tui) | Complete |
| [M4 web UI](#m4-web-ui) | Complete |
| [M5 single executable](#m5-single-executable) | Complete |
| [M6 bundled web client](#m6-bundled-web-client) | In progress |

## M0 walking skeleton

The Claude adapter drives real sessions from end to end. The Session Host, the Presentation
Transcript and the shared reducer are in place behind the Backend Adapter contract.

```bash
npm start -- --backend claude "Use Glob to list *.json here, then say DONE"
```

Findings:

- **Spike 0.** The Agent SDK works on subscription credentials with no `ANTHROPIC_API_KEY`. It also
  works when every `CLAUDE*` variable is removed from the child environment
  (`spikes/subscription-auth.ts`).
- **Streaming input never initialises itself.** `query()` emits nothing until the input stream
  yields its first message. So a Backend Adapter must not wait for the init message before it
  returns, or it deadlocks. Capabilities therefore arrive late, through `capabilities_changed`.
- **`bypassPermissions` hides `canUseTool`.** Flow expresses pre-approved tools as
  `permissionMode: "default"` plus `allowedTools`. `canUseTool` handles the rest: it raises a
  Permission Prompt for the human to decide (ADR 0018), or an Enquiry for `AskUserQuestion`
  (ADR 0016).
  - The SDK warns that allowlisted tools skip the callback. That is the intent, not a
    misconfiguration.
  - `bypassPermissions` would remove the only place where a tool can wait for a person.
  - A callback must never fail to settle or deny. That would make a turn that nobody can end.

## M1 pi adapter

Both backends are behind the same Backend Adapter contract.

pi's real `AgentSessionEvent` union was read from its type declarations with the compiler API
(`spikes/probe-type.ts`), not inferred. This corrected three things:

- **pi separates runs from turns.** `agent_start` and `agent_end` bracket one exchange with the
  human. `turn_start` and `turn_end` fire once for each model call, many times in one exchange.
  Flow's `turn_started` and `turn_ended` map to `agent_*`. A map to `turn_*` would emit N pairs for
  each prompt.
- **`agent_end` carries `willRetry`.** When it is set, pi is about to retry automatically and the
  exchange is not over. So Flow does not emit `turn_ended` yet.
- The union has 17 members, including `compaction_start` and `thinking_level_changed`. Existing
  consumers do not show these.

`Capabilities.providers` is useful: Claude reports `["anthropic"]`, pi reports 32.

pi keeps its own credential store, so live pi runs need `pi` and `/login`.
`test/backend/pi-mapping.test.ts` covers the translation without credentials.

## M2 durability and revive

Agent Sessions live longer than the process that started them.

```bash
flow --backend claude "Remember the word marmalade"   # prints a session id
flow --session <id> "What word did I ask you to remember?"   # → marmalade
flow list
```

[operating-the-host.md](operating-the-host.md#durability) gives the storage rules. The reasons:

- The transcript is append-only. So Flow records that a torn turn ended (`reason: "aborted"`). It
  does not rewrite the turn.
- Dormancy is an event (`session_dormant`), not only host state. Without it, a client that reduces
  the transcript sees `turn_ended` and shows a ready prompt for a session that has no backend.
- Claude's `resumeDropsTurn` takes a message id, not a boolean. So there is no generic "drop the
  torn turn" hint to pass down. Flow closes the torn turn in its own transcript instead.

## M3 transport and TUI

The terminal client talks to the Session Host over the wire. It never uses a session object.

```bash
flow serve          # Session Host on 127.0.0.1, prints the web handoff URL
flow tui            # terminal client; connects to a running host or embeds one
flow list
```

Transport is POST for commands and SSE for events. Flow uses SSE, not WebSocket, because the
transcript goes in one direction and has sequence numbers. So reconnect is `?since=N`: a replay,
not a resynchronisation protocol. It needs no dependency in Node or in the browser.

The tests found two bugs that a manual try would probably miss:

- **A stdin chunk is not a keystroke.** A paste arrives as one chunk, and an arrow key as a
  three-byte escape sequence. So Flow splits chunks into keys.
- **Chunk handlers raced.** Key handling is async. A chunk that arrived during the previous one
  mixed with it and applied keys out of order. Flow now processes chunks strictly in sequence.

## M4 web UI

A richer surface than the TUI, on the same transport and the same reducer.

```bash
flow serve   # prints http://127.0.0.1:PORT/auth?token=… — open that once
flow serve --port 3000 --address 0.0.0.0   # containers reached via a published port
```

M4 showed several Agent Sessions at once, collapsible tool calls, file edits as diffs, search in
each pane's transcript, a model picker grouped by provider, Steering Queue depth and context usage.
M6 rebuilds this surface with one Agent Session on screen at a time.

The browser ran **the same reducer as the TUI**, not a copy. `src/client/reduce.ts` and
`src/client/diff.ts` imported only types. So stripping the types left standalone ESM with no
imports. The host served them as `/reduce.js` and `/diff.js`, with no bundler. A test loaded what
the Session Host served and asserted that it gave the same state as the TypeScript reducer.
**M6 replaces this**: the browser now imports the reducer.

[remote-access.md](remote-access.md) explains the `/auth` handoff and the OIDC gate.
[development.md](development.md#how-the-web-client-is-served) explains the asset manifest.

## M5 single executable

`npm run build:binary` makes `build/flow`. [development.md](development.md#single-executable) gives
the prerequisites.

The build needed five things:

- **`import.meta.url` becomes `undefined` in a CommonJS bundle.** This breaks the
  `createRequire(import.meta.url)` calls in bundled dependencies. The build defines it as a real
  file URL.
- **pi loads lazily** (`src/backend/registry.ts`). It is ESM-only and pulls in native and wasm
  packages, so a bundle cannot require it at startup. When you ask for a pi session and pi is
  absent, you get a clear error, not a crash at launch.
- **The CLI starts directly, not through `process.execPath`.** The SDK runs the CLI as
  `<node> <cli-path> …`, with `process.execPath` as the interpreter. In a single executable that
  *is* the Flow binary. So the spawn starts Flow with the CLI's arguments, argument parsing rejects
  them, and the error is `Claude Code process exited with code 1`.
  - A `spawnClaudeCodeProcess` override runs the CLI path itself.
  - It changes *only* interpreter spawns. A native Claude Code install starts with no interpreter,
    so the binary is already the command and `args[0]` is a real flag.
  - If the override moved `args[0]` there, it would run `--output-format` as a program. The SDK
    reports that as "native binary exists but failed to launch — probably a libc mismatch", which is
    not the real problem.
- **Native `esbuild`, after a period on `esbuild-wasm`.**
  - The wasm build was chosen to keep the lockfile portable. The native package resolves to a binary
    for each platform, so an install on macOS seemed likely to break the Linux build.
  - It never would. `package-lock.json` is lockfileVersion 3. It records the optional binary of
    every platform, not only the host's. It already did this for both agent SDKs, and now does it
    for M6's Rolldown and lightningcss bindings too. `npm ci` picks the correct one for each OS.
  - So the shim protected a property that the tree does not have, and it shipped two esbuilds.
  - The change gave a byte-identical bundle. It also removed `logLevel: "silent"`. That existed
    only because the wasm stdio shim failed when it wrote its own summary to a pipe. The native
    package writes nothing there.
- **The packaging asymmetry stayed**, opposite to what you would expect. pi is in-process and would
  bundle cleanly without its native dependencies. Claude, which looks like a library, is the one
  that needs an external executable.

## M6 bundled web client

The browser client is a Vite and React application in `web/`. It *imports* `src/client/reduce.ts` as
TypeScript. The host no longer serves that file with its types removed.

### Why M4's arrangement is reversed

- When the browser imports the reducer, the compiler makes two copies impossible. A test no longer
  has to check it.
- It removes a limit: in M4, shared code could not import a value. That is why
  `src/client/diff.ts` compares lines naively.
- So `src/client/` becomes the shared front-end core: reducer, transport, and the presentation logic
  that both clients need. Everything in it must stay free of DOM types, because the TUI compiles it
  in a program that has none.

The Session Host knows nothing about Vite. `prebuild:binary` builds `web/dist`, and the binary build
turns it into the manifest that it injects. The rest of the chain does not change. The host now
serves a manifest, not six hard-coded files.
[development.md](development.md#how-the-web-client-is-served) gives the caching rules.

### Drift checks

Drift is still possible, in a different form. Two gates replace the test that ran the served bytes:

- The build refuses to emit a bundle whose module graph does not contain the shared client modules.
- `test/assets-embedding.test.ts` checks that the manifest generator follows the content types,
  the base64 boundary and the `immutable` rule that the host expects.

Staleness is not checked, because the build that embeds the manifest also generates it, so it cannot
be older than its sources. Nothing typechecks the embedded bytes now. They are `JSON.stringify` of a
plain object, so the generator is tested instead.

### The UI

The UI is master–detail: a rail of Agent Sessions, and one focused Agent Session in a pane. M4
opened one pane for each Agent Session.

- One at a time is the design, not a limit. The rail shows the state of the others, in bands with
  the most active first.
- Each row has a dot, a Subagent count, a queue depth and a relative time. That is enough to monitor
  any number of sessions without reading them.
- Ten modules are shared with the terminal client, not the three that M4 allowed. The model and
  Effort pickers, the status predicates, transcript search and the relative clock now each have one
  implementation, not two that had already drifted apart.
- Styling is stock shadcn/ui on Base UI primitives, with no custom palette. The six states of an
  Agent Session map to shadcn's own chart tokens.
- Monospace is used only where character alignment has meaning: transcript text, tool output, diffs
  and Scope paths.

### Open gap

No automatic test proves that the shipped bundle renders. The compiler, the module-graph check and
the hash prove things about the bundle, not that the app works. A browser-driven smoke test is
designed but deferred.
