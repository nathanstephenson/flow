# 38. Saved step corrections resume retained Workflow checkpoints

## Status

Accepted; amends the fixed-definition recovery rule in ADR 0023.

## Decision

Normal recovery continues to use the execution's retained Workflow Definition. Saving a definition
never changes running or stopped work by itself. Explicit `retry-updated` recovery may adopt a
saved correction to one failed, timed-out or interrupted Workflow Step's executable configuration.
The agent cannot supply replacement definitions or arbitrary patches through this tool.

`workflow_inspect` reports both the execution recovery revision and the current saved definition
revision. `workflow_recover` accepts `retry-updated`, the failed `stepId` and that
`definitionRevision`, and requires fresh human confirmation. Confirmation displays the saved step
configuration. Both revisions are checked again after asynchronous readiness work; saving another
correction while confirmation is pending revokes that consent. HTTP recovery is an explicit human
command and requires the saved definition revision too.

Compatibility is deliberately conservative. Workflow identity, Backend Adapter, Project binding,
graph topology, loops, schemas, input mappings, permission policy and every other Workflow Step
must remain unchanged. The target's command, code, instructions, model, Effort, timeout, accepted
exit codes, branch condition or secret references may change where applicable. MCP tool identities
and schema snapshots cannot be retargeted. Completed work cannot be rewound or silently invalidated.
Incompatible edits require a new Workflow Execution, not guessing which effects can be repeated.

The same Workflow Execution, Scope, original input, completed outputs, previous attempts, loop
identities/grants and activity remain. The retry uses the failed attempt's retained input, not a
new evaluation of mappings. New attempt numbers continue the existing sequence. Before launching,
execution persistence records the previous and corrected step configuration, application time and
new attempt number, allowing inspection and reload without losing which configuration ran before.
Old execution records without correction audit fields remain readable.

Execution isolation and runtime policy remain the captured policy; a corrected definition is not
permission to weaken isolation or replace the execution Scope. Existing readiness, model, Effort,
secret, MCP identity and output validation gates apply to corrected work too. Corrected-config
replay is never a safe automatic recovery: even a failed operation may already have caused effects.
A rejected or stale correction leaves the checkpoint and original definition unchanged.

## Limits

This preserves Workflow execution context, not a suspended SDK conversation inside a terminated
Workflow Subagent. An Agent Step retry starts a new Subagent with its corrected instructions and
retained structured input. Prior activity remains inspectable; completed upstream work is not
repeated. No arbitrary jump into a completed step or topology migration is supported. Deleting a
saved definition does not prevent ordinary recovery from the retained execution copy.
