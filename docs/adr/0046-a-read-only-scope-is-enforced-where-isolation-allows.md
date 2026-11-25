# 46. A Read-only Scope is enforced where isolation allows

## Status

Accepted.

## Decision

An Agent Session can have a Read-only Scope. It is set when the Agent Session is created and does
not change. Only the configured Project Root can be a Read-only Scope, and it cannot be a Worktree.
A Fork of a read-only Agent Session is read-only.

The Session Host chooses the enforcement each time a Backend Session starts:

- **Bubblewrap and per-session Sandbox.** The Scope is mounted read-only. The agent loses Write,
  Edit and NotebookEdit and keeps Bash.
- **Unrestricted and Shared Sandbox.** Best effort. The agent loses Write, Edit, NotebookEdit and
  Bash. The UI shows that this is not a boundary.

A read-only Agent Session refuses Git writes, Tour and file Rewind. A conversation Rewind is
permitted.

When a read-only Agent Session creates an Agent Session with `session_create`, a Project Scope has
no restriction. Any other Scope must be the Project Root, and the new Agent Session is read-only.

Human Shells are unchanged (ADR 0028).

Host work that needs no writes uses the same read-only mount. A Backend Session with no tools,
such as a probe or the Summary Model, and stdio MCP discovery for workflow authoring (ADR 0031)
mount their Scope read-only in Bubblewrap and per-session Sandbox. The Workflow Builder keeps its
private folder (ADR 0030).

## Considered options

- **Refuse a Read-only Scope where it cannot be enforced.** Safe, but the option is then not
  available in unrestricted mode or with a Shared Sandbox, where it is still useful.
- **Read-only mount in a Shared Sandbox.** The Shared Sandbox mounts the Project Root writable for
  all of its Agent Sessions, so one Agent Session cannot have a read-only view of it.

## Consequences

In unrestricted mode and with a Shared Sandbox, an agent can still write through MCP servers,
Workflow code or other tools. Without Bash, the agent cannot run commands to read the Projects.

The enforcement follows the current Settings, so a change to the Isolation Mode or Sandbox Sharing
applies at the next Revive.
