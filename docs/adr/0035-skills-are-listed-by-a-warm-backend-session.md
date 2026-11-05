# 35. Skills are listed by a warm Backend Session

## Status

Accepted. Amends ADR 0020: a probe session can stay alive after its answer.

## Decision

The New Agent Session view asks for the Skills of a Scope before an Agent Session exists. Each ask
opened and disposed a Backend Session. In Sandbox mode, each ask created a VM. This was slow.

The Session Host keeps one warm Skills session for each Backend Adapter, for the last Scope asked.
The next ask for that Scope calls `skills()` on it. `skills()` reads the disk again on each call, so
the answer is not stale. An ask for a new Scope replaces the warm session. The host disposes the
warm session when:

- it sends an error notice;
- its `skills()` throws (the host then does one cold probe in the same ask);
- a Shared Sandbox must be created again (ADR 0034);
- the host stops.

The host-start model probe gives its session to an empty slot. Thus the first Skills ask for
`projectRoot ?? cwd` after host start is warm.

Each Backend Session start and each probe writes one JSON line to `<state root>/timings.jsonl`. At
host start, Flow cuts the file to its last 2000 lines when it is larger than 1 MB.

## Consequences

Each Backend Adapter can keep one idle process. In per-session Sandbox mode, that is one idle VM
for each adapter. A Skills ask for a new Scope is still cold.
