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

Next: M1 — the pi adapter, running the same contract unmodified, before either UI exists.

## Development

```bash
npm install
npm run typecheck
npm test
npm run spike:auth   # re-verify subscription auth

GOODHARNESS_E2E=1 npm test   # includes the live Claude contract (spends tokens)
```

Sources are run through Node's `--experimental-strip-types`, so TypeScript is limited to
erasable syntax: no parameter properties, enums, or namespaces. Relative imports carry the `.ts`
extension and are rewritten on build.
