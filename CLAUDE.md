# CLAUDE.md

Domain language and architecture live in `CONTEXT.md` and `docs/adr/`. Read those first.

## Driving the web UI in a browser

Playwright's chromium is already installed at `/ms-playwright` and `PLAYWRIGHT_BROWSERS_PATH` is
set — do not run `playwright install`. The package resolves from
`/usr/local/share/npm-global/lib/node_modules/playwright`.

Authenticate by visiting the cookie handoff before anything else; every other route answers 401:

```js
await page.goto(`http://127.0.0.1:5173/auth?token=${token}`, { waitUntil: 'domcontentloaded' });
```

The token is `<state root>/token`, and `<state root>/daemon.json` carries the `{ url, token }` the
running Session Host wrote.

**Never wait on `networkidle`.** The client holds the event stream open for the life of the page
(ADR 0008), so it never fires and every navigation times out at 30s. Use `domcontentloaded` plus an
explicit wait for the element you care about.

Prefer waiting on two things rather than one when a turn is in flight — a transcript row *and* the
composer state. Waiting on prompt text alone matches the copy `composer-permission.tsx` deliberately
keeps rendering through the exit animation, so a screenshot can fire against a prompt that has
already been decided.

## Screenshotting a change, not a stale build

`npm start` builds `web/dist` first through its `prestart` hook, so a Session Host serves the client
as it stood *when that host started* (ADR 0017). The trap is the process,
not the artifact: a host someone left running before your branch existed serves that older client
and runs that older `src/backend` and `src/daemon` code, so screenshotting it shows nothing you did.

`npm run dev` fixes only the front half — it serves this worktree's web code with hot reload and
proxies `/api` and `/auth` to whatever `daemon.json` named. Anything reaching into `src/backend` or
`src/daemon` needs a host restarted from the branch too.

To do that without disturbing a Session Host someone is using, give it its own state root and port:

```
FLOW_STATE_DIR=/tmp/scratch npm start -- serve --port 4318
FLOW_URL=http://127.0.0.1:4318 FLOW_STATE_DIR=/tmp/scratch npm run dev
```

`FLOW_STATE_DIR` is what keeps it isolated — its own token, `config.json`, and transcripts. Without
it, a second host overwrites the `daemon.json` the real one and the TUI depend on. `FLOW_URL` is
read once at Vite config load, so repointing the proxy means restarting Vite.
