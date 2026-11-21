# 43. Git State is derived host state on SessionSummary, not a transcript event

## Status

Accepted. For Git State, supersedes the reasoning in the `/api/branches` comment in
`src/daemon/server.ts`, which said Git facts are a query and not state that every client polls.

## Decision

The Session Host keeps one Git State for each Scope in memory. Agent Sessions on the same Scope
share it. `SessionSummary.git` carries a small summary: a revision, the changed-file count, commits
ahead of and behind the upstream, whether an upstream exists, and the Pull Request number, URL,
state, draft flag, check status, review decision and unresolved thread count.

The host reads local state again at create, at Revive, at turn end, after each Git pane operation,
on the `refresh_git` command, and after each tool call during a turn. Tool calls cause at most one
read each 3 s, with one trailing read. The host does not watch the file system.

The daemon polls the Pull Request with one GraphQL query for each distinct base repository, head
repository and branch across Live and Dormant Agent Sessions. A group is due each 30 s when a client
has the stream of one of its sessions open, and each 5 min otherwise. Settled and Ended sessions are
not polled and keep the last value. A failed poll keeps the last value.

One resolver maps a Scope to its push remote, head repository, base repository and Pull Request.
The order of remotes is: branch pushRemote, `remote.pushDefault`, branch remote, `origin`, the sole
remote. For a fork, the base repository is its parent. Only github.com is supported. Repository
identity is cached for each Scope, remote and push URL.

## Considered options

- **A `git_state` Agent Event in the Presentation Transcript.** The transcript is append-only and
  records what a human saw. A count that changes after each tool call would grow every transcript
  without limit, and a Dormant Agent Session has no Backend Session to append for it, but its Pull
  Request is still polled.
- **A query, as `/api/branches` is.** Each client would ask for each session, and the rail would
  need one request for each row. The rail already reads `SessionSummary` each 2 s, so the summary
  costs no new request.
- **A file system watcher.** It is costly for large Scopes and misses changes on some file systems.
  The listed read points cover the changes that Flow and its agents make.

## Consequences

Git State is lost when the Session Host stops. It is read again at create and Revive, and for a
Dormant Agent Session at the next poll. "Behind" uses the last fetched upstream ref. The unresolved thread count uses the first 100
threads. A browser tab that is hidden keeps its stream open, so its sessions poll each 30 s.
