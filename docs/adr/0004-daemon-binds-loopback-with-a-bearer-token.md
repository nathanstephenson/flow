# The Session Host binds loopback and requires a bearer token

The Session Host listens on 127.0.0.1 only, with a per-daemon token generated at startup and stored
mode 0600 in the config directory. The TUI reads the token from disk; the browser receives it once
via a launch URL that immediately sets an HttpOnly cookie and redirects, keeping it out of history
and referrers. Origin is checked strictly and CORS is not enabled. This is stronger than typical
local dev tooling because tools are pre-approved: an endpoint that accepts a prompt and runs Bash
without prompting is an arbitrary-code-execution endpoint, reachable by any local process or any web
page that can resolve to loopback. Remote access is explicitly not supported.

A `--address` flag can bind the socket wider, because a sandboxed or containerised host is often
reached through a published port that cannot see a loopback-only socket. It is deliberately a flag
rather than a default, and it warns on startup: off loopback the bearer token becomes the only thing
between the network and arbitrary command execution as the user running the host. The advertised URL
stays loopback regardless, since that is what clients on the same machine should dial.
