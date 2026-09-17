# 23. Workflow Executions own independent work and human requests

## Status

Accepted.

## Decision

The Session Host owns one Workflow Execution slot per Agent Session. Tests and executions awaiting
manual recovery retain that same slot. This work is independent of the parent turn and Steering
Queue. A Dormant eligible Agent Session is Revived on demand; an Ended Agent Session cannot start
or recover work.

The execution retains its Workflow Definition, typed inputs and runtime Settings. Definition edits
and deletion do not change it. Project restrictions compare directory identity, using the source
Project for a host-owned Worktree. Runtime readiness probes are asynchronous and cached. Settings
changes refresh readiness for new work, not the executors already serving an execution.

Each Agent attempt owns a distinct backend handle and launch ID. Code steps own their runtime
processes. Cancellation, Settle, End and shutdown wait for owned work to stop. Backend error notices
conservatively interrupt workflow work, because the current adapter contract does not distinguish
backend loss from other errors. Interrupted work requires explicit recovery; it is never replayed.
Reap stops work, releases scheduler records, and deletes the Agent Session's execution history.

Workflow Enquiries and Permission Prompts belong to the attempt, but are relayed by the parent model
through the existing parent composer. The host wakes an Idle parent, waits behind a running or
Awaiting turn, and never Revives a Dormant parent automatically. Existing parent requests go first;
Workflow requests follow oldest-first, one per parent relay turn. Opaque request IDs and live callback
checks bind every answer to its execution, Step, attempt, Subagent and original request. An old answer
cannot revive work. Always becomes Standing Authorisation only after the originating callback accepts
it; direct Workflow-tool prompts offer Allow or Deny only. Auto-accept does not answer Enquiries. This
extends ADRs 0016, 0018 and 0022 for host-launched work without changing the request rules for ordinary
parent turns or model-launched Subagents.

Private activity is bounded and saved separately from the Presentation Transcript. Named secrets
are resolved for explicit step aliases. Agent JSON is validated and literal secret values are
redacted before persistence. Literal redaction is not a defence against deliberate encoding or
transmission by a model or program.

A full execution's final structured JSON result is delivered through one host-driven parent turn.
The Session Host waits for any current parent turn, then asks the parent to provide a readable
summary and the exact structured output. A durable per-execution marker prevents repeated callbacks
or restart reconciliation from producing duplicate announcements. Step-test results remain confined
to the Workflows surface and never notify the parent. This monitoring turn does not make the
Workflow Execution itself occupy the parent while it runs; ordinary chat remains usable throughout.

Dedicated per-execution Spend snapshots add workflow billing to the Agent Session without changing
Conversation Context occupancy or entering backend prior Spend.

## Consequences

A parent turn can continue while workflow work awaits a human. The execution view shows pending
status and management actions, while the parent relay owns the interactive controls. Full running
executions contribute independent working activity to the rail without changing Idle/Running/Awaiting
until an actual relay turn starts. A restarted host retains private activity, Spend and notification
markers, but no request callback survives. Failed tests and interrupted executions require an
explicit Retry, Supply output, Continue or Cancel before the slot is free.
