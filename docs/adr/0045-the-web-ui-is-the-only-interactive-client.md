# 45. The web UI is the only interactive client

## Status

Accepted. Removes the TUI (`flow tui`, `src/tui/`). The ADRs that mention the TUI stay as history.

## Decision

The web UI is the only interactive client. The CLI keeps `flow serve`, `flow list`, `flow update`
and one-shot prompts.

`src/client/` stays a front-end-neutral layer with no DOM types. The CLI and the web UI use it, and
a future client can use it.

## Considered options

- **Keep the TUI.** Nobody used it, and its features fell behind the web UI. ADR 0008 and the README
  said that the two front-ends must not drift, but the TUI did drift.

## Consequences

- The `configuredScope()` read of the Project Root in the CLI is removed. A one-shot prompt does not
  use the Project Root (ADR 0010).
- The packed-install test no longer checks that a TUI attaches to a background host.
