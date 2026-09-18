# The Session Host uses an explicit bearer credential and may delegate browsers to OIDC

The Session Host listens on `127.0.0.1` by default, with a durable random bearer token stored mode
0600 under the state directory. Tools may be pre-approved, so reaching an authenticated endpoint can
mean running an arbitrary command as the daemon user. The token is therefore a credential and all
origins are checked strictly; CORS is not enabled.

In the default local deployment, the browser receives that token once through `/auth?token=…`. The
route immediately moves it to an HttpOnly, SameSite=Strict cookie and redirects, keeping the token
out of later URLs and JavaScript. A `--address` flag may bind the socket wider for a container or a
trusted private network, but it is deliberately not the default and prints a warning. A reverse
proxy must preserve the browser's Host header in this mode.

## Optional external browser gate

A personal deployment behind an HTTPS reverse proxy may configure all four `FLOW_OIDC_*` variables.
Flow then discovers a generic OpenID Provider and uses a confidential Authorization Code flow with
S256 PKCE, state, nonce, signed ID-token validation and exact issuer/audience checks. Partial or
invalid configuration stops the daemon before it listens. Plain HTTP is accepted only for localhost
development.

OIDC changes **browser authentication**, not Flow's trust model. Everybody admitted by the issuer
shares complete access to the same Agent Sessions, files, shells and settings. There is no per-user
isolation or authorisation layer. Provider access, refresh and ID tokens remain server-side in a
0600 file; the browser gets an unrelated opaque HttpOnly cookie with a seven-day absolute lifetime.
Refresh-token rotation is persisted and concurrent requests coordinate one refresh.

The local `/auth` handoff and its `flow=` cookie are disabled in OIDC mode. The daemon bearer token
continues to work when explicitly presented in an `Authorization` header, including by remote CLI
and TUI clients. This is an intentional administrative bypass and must be distributed like a root
credential. A browser cannot obtain it from Flow.

All documents, immutable assets, APIs, SSE streams and Shell WebSockets pass through the same gate.
Unauthenticated document navigation begins login and restores only a same-origin deep link; API
requests return 401 with an explicit reauthentication hint. A rejected command is never replayed
after login. Origin validation uses the configured public app origin and never trusts `Forwarded` or
`X-Forwarded-*` headers.

Logout is local to Flow: it invalidates the browser session, persists that fact, closes its SSE and
WebSocket connections, and leaves Agent Sessions running. There is no issuer-wide logout. Signed
OIDC Back-Channel Logout tokens can revoke matching provider `sid` or `sub` sessions immediately;
replay fingerprints are persisted. Account disablement is immediate only when the issuer sends such
a notification. Discovery and ordinary ID-token validation cannot detect a disabled account by
themselves.

The MCP OAuth callback remains the exception to the app-session gate. It has its own five-minute,
single-use state credential and can only complete a sign-in begun by an authenticated Flow request
(ADR 0024); external OIDC neither wraps nor weakens it.
