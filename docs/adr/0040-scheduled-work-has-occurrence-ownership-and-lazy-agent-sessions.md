# 40. Scheduled work has occurrence ownership and lazy Agent Sessions

## Status

Accepted. Amends ADRs 0013, 0023 (Workflow Executions), 0032, 0033 and 0034.

## Decision

The Session Host admits Workflow Schedules while running; an open browser is unnecessary. There
are no OS timers or CLI/TUI schedule commands. Multiple schedules can reference one definition.
Each saves fixed typed inputs, an opted-in source Project, selected MCP connections, a recurrence,
an overlap limit (default 3, range 1–100) and optional local-base-branch Worktree provisioning.

Intervals measure elapsed minutes/hours/days, with a one-minute minimum. Daily schedules save an
IANA timezone and HH:mm: skip nonexistent local times and use only the earlier repeated time.
Temporal 0.5.1 supplies these semantics on Node 22. Enable/re-enable and timing edits establish a
strictly future cursor; unrelated edits retain it. Completion never shifts an interval anchor.

Admission is serialized with mutations. A stable identity derived from schedule ID, activation and
due time is durably claimed before effects; provisioning reserves overlap capacity. Running and
input/recovery waits also reserve capacity. Excess occurrences are recorded, not queued. Live
callbacks tolerate 30 seconds of lateness. Startup and older due times record grouped missed ranges
and advance to the future: no replay backlog. A crash during uncertain provisioning is interrupted,
not relaunched. This is not exactly-once remote execution.

Each launch reads and validates current root/reachable definitions, inputs, source Project and MCP
contracts, then retains an immutable execution snapshot. Preflight failures create redacted history,
not Agent Sessions, and do not disable future occurrences.

### Ownership and interaction

Manual executions retain their version-1 session-owned checkpoint format and one slot per Agent
Session. Version-2 scheduled executions use occurrence ownership and independent slots, with
checkpoint/activity state under `workflow-schedules/executions`, outside transcript directories.
An optional Agent Session association never changes execution identity or checkpoint ownership.
Owner and association indexes are reconstructed once at startup and updated with checkpoint writes;
Agent Session queries do not scan unrelated occurrence checkpoints. After launch, the execution
checkpoint is authoritative for occurrence status and overlap capacity, even if a history-summary
write fails. Incomplete admission claims are interrupted, not replayed or left reserving capacity.

Code and direct MCP execute without an AgentBackend. Only reaching an agent step, asking for human
input, or entering recovery attaches an Agent Session. An unreached agent branch never probes its
model. A shared attachment promise and durable intended identity prevent concurrent callbacks from
creating duplicate sessions. Failed attachment remains visible and requires explicit retry; uncertain
effects are not replayed. Attached work uses existing parent relays, authorisation, Attention,
completion and Spend. Pure automated success has no naming or completion-model turn.

### Isolation

Scheduled code/MCP retain an execution-owned environment with captured isolation/runtime policy.
None and Bubblewrap use scoped direct MCP; Sandbox uses an execution-owned VM/Shared Sandbox lease
and an MCP-only worker RPC mode, not an AgentBackend or host-side Sandbox stdio fallback.

This deliberately amends the same-VM assumption in ADRs 0032/0033: lazy attachment opens its normal
Backend Session boundary while scheduled code/MCP keep their original environment, so promotion
cannot replace a VM under parallel work. Shared Sandbox mounts additionally include private scheduled
execution state and registered worker resource/authentication mounts before taking a non-evictable
occurrence lease. Recovery waits retain the environment; rejected recovery never tears it down or
invalidates executors still used by deadline handlers. Durable own-VM ownership is reconciled even
when a crash precedes the first execution checkpoint, and failed removal retains its journal for retry.
Unavailable isolation fails closed. Captured policy belongs to the occurrence's code/MCP environment;
new Backend Sessions use current Settings, including when an associated Agent Session is Revived.
Explicit recovery can replace a failed MCP worker without replacing its Sandbox or replaying calls.
Cancellation and shutdown abort provisioning before waiting for it, then stop owned workers. Failed
Sandbox reclamation retains its journal for retry and cannot skip unrelated host shutdown work.
Admission stops before execution shutdown. Sessionless work participates in update/drain guards.

### Worktrees and retention

Provisioning journals the intended uniquely named Worktree before Git effects and serializes local
repository allocations. It uses the saved local base branch's current local commit, without fetch or
copying dirty source files. Source Project identity remains separate from execution Scope. Attachment
adopts the existing Worktree and persists ownership in Agent Session metadata before backend creation.

Pausing/deleting does not cancel admitted work or erase its history. Terminal history expires seven
days after completion; active/input/recovery work never expires. Agent Session Reap cannot erase
scheduled history, and history expiry cannot delete transcripts or Spend. Sessionless Worktree
cleanup checks cleanliness and the Worktree's current HEAD against merged refs, not only its original
branch; unsafe cleanup preserves the tree/refs and a compact warning independent of expired payloads.
External retention cleanup does not hold the admission or schedule-mutation queue. Associated Worktrees follow Agent Session lifecycle rules,
except that a nonterminal scheduled occurrence pins its associated Agent Session and Worktree against
Reap, including after Settle and during startup before reconciliation. Settle stops execution without
terminalizing recovery; the engineer can Revive and recover or explicitly cancel the occurrence.
Once all linked occurrences are terminal, ordinary session retention and safe Worktree cleanup resume.

## Consequences

Shared-directory overlaps can conflict, including across schedules; the UI warns and offers fresh
Worktrees. Seven days is a retention window, not a disk quota: recovery work and unsafe Worktrees may
remain longer. Durable claims favor avoiding duplicate effects over automatic recovery of uncertain
launches. Settings → Workflows remains the definition editor; a dedicated deep-linkable Schedules
page manages timing, history, execution inspection and links to existing parent interaction controls.
