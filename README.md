# GoodHarness

Run and watch coding-agent sessions from a terminal or a browser, over more than one agent SDK.

- **Local mode (v1)** — a Session Host daemon on loopback, with a TUI and a web UI as equal clients.
- **Backends** — the Claude Agent SDK (on your own Claude subscription) and the pi SDK (for models
  Claude doesn't serve). Backend is chosen per Agent Session.

See [CONTEXT.md](./CONTEXT.md) for the domain language and [docs/adr](./docs/adr) for decisions.

## Status

Pre-M0. Spike 0 (Agent SDK on subscription credentials, no API key) is verified — see
`spikes/subscription-auth.ts`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run spike:auth   # re-verify subscription auth
```
