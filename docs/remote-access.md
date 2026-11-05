# Remote access

By default, the Session Host listens on `127.0.0.1` and admits a browser through a one-time token
handoff. This page describes other ways to reach it.

## The token handoff

`flow serve` prints `http://127.0.0.1:PORT/auth?token=…`. Open that URL once.

A browser cannot put an `Authorization` header on a navigation or an `EventSource`. So `/auth` puts
the token into an HttpOnly cookie once. The UI itself, not only the API, requires that cookie.

For a personal deployment that other machines can reach, use the [OIDC gate](#external-oidc-gate)
instead.

## Containers

To reach a host in a container through a published port, bind to all addresses:

```bash
flow serve --port 3000 --address 0.0.0.0
```

## External OIDC gate

Flow can give browser admission to any OpenID Provider that follows the standard. CLI and TUI
clients continue to use the bearer header.

> **This is a shared personal deployment. It is not multi-user isolation.** Every person that the
> issuer admits has full access to every Agent Session, Shell, file, secret and Setting that the
> daemon can reach.

### Configure

Set all four variables, or none.

| Variable | Example |
| --- | --- |
| `FLOW_OIDC_ISSUER` | `https://id.example.com` |
| `FLOW_OIDC_CLIENT_ID` | `flow` |
| `FLOW_OIDC_CLIENT_SECRET` | `replace-me` |
| `FLOW_OIDC_PUBLIC_APP_URL` | `https://flow.example.com` |

- If the configuration is partial or not valid, the daemon fails before it listens.
- Without this configuration, the local `/auth?token=…` behaviour stays.

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

### Issuer requirements

The issuer must support:

- OIDC discovery,
- Authorization Code,
- a confidential client authentication method (`client_secret_basic` or `client_secret_post`),
- signed ID tokens,
- S256 PKCE,
- refresh tokens,
- the `openid` scope.

Flow requests `offline_access`.

Back-channel logout is optional. But it is necessary for immediate revocation when the issuer
disables a user, because discovery alone cannot report an account change. Logout inside Flow does
not do a global issuer logout.

### Reverse proxy

- Terminate HTTPS at the reverse proxy.
- Forward `/`, `/api`, `/assets` and `/oauth` to the daemon.
- Include HTTP upgrade for Shell WebSockets, and streaming responses for SSE.
- `FLOW_OIDC_PUBLIC_APP_URL` is the only browser origin that Flow trusts in this mode. Do not
  rewrite it from request headers.
- Do not expose the daemon directly. Flow ignores `Forwarded` and `X-Forwarded-*` for its security
  decisions.
- HTTP (not HTTPS) issuer and app URLs are accepted only for `localhost`, `127.0.0.1` or `::1`, for
  development.

### Tokens and browser sessions

Provider tokens stay on the server.

- Flow stores them, and opaque browser sessions, under `$FLOW_STATE_DIR/oidc/`. The directory has
  mode 0700 and the files have mode 0600. There is no additional application-level encryption.
- Flow rotates refresh tokens and coordinates concurrent refreshes.
- A browser session has an absolute lifetime of seven days.
- Flow logout, expiry, a failed refresh or a valid back-channel notification revokes the browser
  session. This closes its SSE and WebSocket connections. It does not end Agent Sessions.

### Bearer token bypass

The daemon bearer token stays as an explicit administrative bypass:

```bash
curl -H "Authorization: Bearer $(cat "$FLOW_STATE_DIR/token")" \
  https://flow.example.com/api/sessions
```

- A bearer client does not use OIDC. It works remotely when the reverse proxy forwards the header.
- Protect that token. It gives full access to the app.
- In OIDC mode, `/auth` is disabled and an old `flow=` cookie is ignored. So Flow cannot give the
  bypass to a browser.

### Test issuer

The repository includes a local Provider for integration tests:

```bash
npm run test:oidc-issuer -- http://127.0.0.1:5173
# In another terminal, export the four variables it prints, start Flow on :4318, then `npm run dev`.
```

- It does discovery, S256 PKCE, confidential client authentication, signed ID and logout tokens,
  and refresh-token rotation.
- It admits one fixed test subject automatically.
- Use it only for localhost tests.

Nathan's separate OpenAuth-based issuer is not yet verified as compatible.
