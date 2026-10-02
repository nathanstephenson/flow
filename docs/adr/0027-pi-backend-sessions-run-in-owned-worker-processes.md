# 27. Pi Backend Sessions run in owned worker processes

## Status

Accepted.

## Decision

A production Pi Backend Session runs in a separate process owned by the Session Host. The adapter
continues to own its SDK sessions, ordinary Subagents, Background Calls and Workflow Subagent handles
(ADR 0022). The process boundary does not create additional Agent Sessions or change their lifetimes.

The Session Host sends Backend Session commands over a private IPC channel and receives Backend
Events in order. Commands are dispatched concurrently: an outstanding prompt or human request must
not prevent Abort, answers or disposal. Capabilities and the resume token are mirrored snapshots;
they are updated before the corresponding events reach the Session Host.

Workflow inspection, recovery and human relays remain host-owned services. MCP connections,
authorisation and credentials remain host-owned too. Workers receive tool metadata and invoke
explicitly allowlisted service operations across IPC, including cancellation; they do not receive
host objects or arbitrary host method dispatch.

A worker failure rejects pending operations and Workflow Subagent outcomes and reports a backend
error. The Session Host closes outstanding work, records the interrupted turn and makes the Agent
Session Dormant. Revive creates a replacement; failed work is never automatically replayed. Disposal waits for owned SDK work to stop, then closes the worker; a
bounded shutdown fallback terminates the process group. Losing the parent channel also shuts down
the worker rather than leaving model work unowned.

Source, npm and single-executable launches enter the same worker dispatcher. The Pi SDK remains
optional in a single-executable installation. Direct adapter construction remains available to
SDK integration tests; production registration uses the worker adapter.

## Consequences

The host no longer executes Pi model tools in its own process. A process boundary alone is **not** a
filesystem sandbox: this decision enables subsequent OS-level restrictions but grants no protection
against tools deleting files outside their Scope. Until that policy is installed, a worker still
has the filesystem authority of the user who launched Flow.

The IPC contract must track additions to Backend Session commands and host services. Tests must
exercise process loss, concurrent answers and cancellation, ordinary background work, Workflow
Subagent handles and the packaged worker entry, not merely a serial happy-path request.
