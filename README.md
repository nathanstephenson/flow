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

Next: M3 — the TUI.

## Development

```bash
npm install
npm run typecheck
npm test
npm run spike:auth   # re-verify subscription auth

GOODHARNESS_E2E=1 npm test       # adds the live Claude contract (spends tokens)
GOODHARNESS_E2E_PI=1 npm test    # adds the live pi contract (needs pi credentials)
```

Sources are run through Node's `--experimental-strip-types`, so TypeScript is limited to
erasable syntax: no parameter properties, enums, or namespaces. Relative imports carry the `.ts`
extension and are rewritten on build.
