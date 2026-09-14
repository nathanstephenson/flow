# Workflow builder scope

Status: implemented scope. Runtime details are in `src/workflows/README.md`; execution ownership is recorded in ADR 0023.

## Purpose and surfaces

Build reusable workflows whose steps execute within an Agent Session.

- Settings → Workflows: manage definitions and visually view and edit graphs with React Flow.
- Agent Session side-panel → Workflows: manually start workflows, answer requests, inspect progress, recover interrupted execution, and view history.
- Settings → Secrets: manage named secrets. Editors select references without displaying stored values.

Definitions are machine-wide by default. A definition can be restricted to one Project, including Worktrees created from that Project. Execution uses the Agent Session's actual Scope, not the source Project directory.

## Execution ownership

- Only one workflow execution can occupy an Agent Session at a time. Concurrent workflows require separate Agent Sessions.
- A workflow requiring recovery keeps that slot until recovered or cancelled.
- Individual step tests use the same slot.
- The parent Agent Session can continue chatting while a workflow executes. A workflow can start while the parent is Running or Awaiting.
- Agent steps receive only configured instructions and explicit inputs, never the parent's Conversation Context.
- Conversation isolation does not isolate files: the parent and workflow share a Scope and can make conflicting changes.
- Each workflow selects one Backend Adapter. It must match the Agent Session's Backend Adapter. On mismatch, block execution and offer to create a matching Agent Session.
- Each Agent step selects a model and Effort supported for Subagents by that Backend Adapter.

## Step types

### Agent

Delegates to a Subagent within the current Backend Session. Receives instructions and explicit input. Returns output validated against its declared schema.

The step completes only when its Subagent and all background work it owns have finished.

### Shell

Executes a shell command in the Agent Session's Scope. This is not Flow's existing Command concept.

Receives input as JSON text through the `$OUTPUT` environment variable, never through insertion into command text. Standard output schema: `{ exitCode, stdout, stderr }`.

Steps can declare accepted exit codes; the default is `0`. This lets a failing test result become valid input for a repair step rather than necessarily failing the workflow.

### TypeScript

Receives parsed JSON as typed `input` and returns JSON validated against its output schema. Generated input types reflect preceding outputs and configured mappings.

Supports filesystem access within the Agent Session's Scope and network access through `fetch`. Filesystem restrictions must prevent escape through symlinks. Imports and process access are not supported; use Shell steps for process operations or broader filesystem access.

External sandboxing is optional, configured explicitly in Settings. When enabled, execution requires an available external sandbox and must not silently fall back to execution without it. Users can disable it when Flow already runs inside a sandbox. Disabling it does not expose imports or process APIs to TypeScript steps; Flow retains its scoped filesystem API checks, but operating-system isolation then depends on the surrounding environment. The UI must state this distinction.

Shell and TypeScript steps have default execution timeouts with per-step overrides. Stopping execution does not undo filesystem changes or network requests.

## Graph and data

- Support sequences, conditional branches, parallel paths, and explicit joins.
- No loops or nested workflows in the initial version.
- Conditions are configured visually. Complex conditions can use a TypeScript step returning a boolean before a visual branch.
- Workflow start inputs are optional named fields with types, defaults, and required-field settings. Collect them before execution.
- Each step declares an output schema through a visual schema editor. Support common objects, arrays, strings, numbers, booleans, and enums.
- Store serializable schemas; generate Zod validation and TypeScript types. Users do not write executable Zod expressions.
- Runtime output validation is required. Invalid output fails the step.
- By default, a step receives the preceding step's output directly.
- Optional visual mappings combine workflow inputs and selected earlier outputs. References are limited to steps guaranteed to have completed before the consumer executes.
- A join collects incoming outputs into an object keyed by step name and waits for all required selected paths.
- Unselected conditional paths are skipped. Joins do not wait for them, and their output fields are optional in generated types.
- Failure and timeout paths receive typed original `input`, `error`, and optional partial output.

## Completion

There is no End node. A selected path ends at its last step.

Wait for all selected paths to finish. A single final step returns its output directly. Multiple final steps return their outputs keyed by step name.

Show the final result in the main Agent Session's Presentation Transcript without starting a parent-agent turn. Workflow progress and failure notices remain available while the parent conversation is independent.

## Permissions and human input

- New workflows default to **Auto-accept**. Users can change the workflow default to **Ask**.
- Steps inherit that default unless explicitly overridden with **Ask** or **Auto-accept**.
- Show each step's effective mode on its node.
- Ask uses existing Standing Authorisation and requests additional permission when needed.
- Auto-accept automatically grants permission requests; it does not bypass operating-system restrictions.
- The setting applies to Agent, Shell, and TypeScript steps, although Shell and TypeScript steps normally do not issue permission requests.
- Permission Prompts appear in the workflow panel and pause only the affected path.
- Agent steps may issue Enquiries in the workflow panel. These also pause only the affected path.
- Auto-accept never supplies answers to Enquiries.
- Named secret references are optional. Resolve values at execution time, not into stored definitions or saved inputs.
- Keep secret values out of displayed configuration and execution history. Output redaction is best-effort and cannot guarantee that executed code will not disclose a secret.

## Failure, cancellation, and recovery

### Failure and timeout

- Let independent parallel paths finish. Block dependent steps.
- No automatic retries initially.
- Steps can have distinct success, On failure, and On timeout paths.
- Recovery follows explicit graph connections only. It can continue into the main path or end at a terminal step; there is no implicit retry or continuation.
- Without a configured handling path, failure or timeout requires manual recovery.
- Successful handling reports **Completed with recovery**, keeping the original error visible.
- An unhandled failure or failed recovery path requires manual recovery.
- User-defined rollback steps are recovery actions, not a guarantee that prior effects can be undone.

### Manual cancellation

Stop all running steps where possible and start no further steps. Do not enter failure, timeout, or other recovery paths. Cancellation cannot undo completed effects.

### Backend or host interruption

Preserve progress when the Backend Session stops or Session Host restarts. Stop execution and require explicit recovery; never automatically repeat interrupted steps.

Keep successful outputs. For an interrupted step, offer:

- Retry step.
- Supply output and continue, validating the supplied output against the step schema.

Warn that interrupted operations might already have made changes.

## Definitions and history

- Each execution keeps a fixed copy of its definition, inputs, model choices, and Effort settings.
- Edits affect future executions only. Recovery uses the original copy.
- Deleting a definition does not delete history or prevent recovery from an execution's saved copy.
- Execution history belongs to its Agent Session and is removed when that Agent Session is Reaped.
- Settings manages definitions, not execution history.

## Progress display

Use a read-only React Flow graph in the workflow panel.

For each step show status, duration, inputs, outputs, and errors. Agent steps also show model, Effort, Spend, and Subagent activity. Shell steps show stdout and stderr.

## Individual step testing

The builder can test a single step with sample input and an explicitly selected Agent Session.

- Use that Agent Session's Scope and require a matching Backend Adapter.
- Validate sample input against its schema.
- Use normal configured permissions and record the test in execution history.
- Execute only the selected step. Do not follow outgoing or recovery connections.
- Disable testing when the Agent Session's workflow slot is occupied.

## Deferred

- Nested workflows. Later design must cover child outputs, cancellation, recovery, and definition versions.
- Scheduled, repeating, and event-based triggers.
- Loops.
- Automatic retries.
- Per-step Backend Adapter selection and cross-adapter execution.
- TypeScript imports and process access.

## Design checks

These checks guided the implementation and remain review criteria:

1. Confirm each Backend Adapter can select Subagent model and Effort, supply isolated input, track owned background work, and route permissions and Enquiries independently of the parent turn. Define unsupported-capability behaviour.
2. Define durable execution records and restart reconciliation. Existing Subagents belong to a Backend Session and cannot survive it. Confirm how Shell and TypeScript execution is stopped after host loss.
3. Select a TypeScript execution boundary that can enforce filesystem, symlink, import, process, network, and cancellation rules. TypeScript types alone provide no security boundary.
4. Define graph validation for conditional joins, handled errors, terminal outputs, stable step identity, and duplicate or renamed step names.
5. Define schema representation, supported Zod subset, generated editor types, and field-mapping validation.
6. Specify secret storage, access controls, injection, and redaction. Reconcile retained inputs with secret references so execution history never stores resolved credentials as configuration.
7. Define timeout limits, cancellation behaviour for process trees and in-flight network requests, output size limits, and artifact references.
8. Confirm Spend attribution and Presentation Transcript events for workflow execution without changing the parent's Conversation Context or turn state.
9. Define recovery when branches have completed independently or files have changed since interruption. Confirm input/output override auditing.
10. Define result rendering for structured output and artifacts, plus failure and cancellation summaries in the main Agent Session.

## Acceptance scenarios

- Edit a workflow visually, start it with typed inputs, and inspect validated outputs in the workflow panel and main Presentation Transcript.
- Run parallel Agent steps with different models and Effort; keep the parent conversation independent and wait for their background work.
- Transform output in TypeScript, pass JSON to Shell through `$OUTPUT`, and choose a visual branch from the result.
- Skip an unselected path without blocking a join; combine multiple terminal outputs by step name.
- Handle failure or timeout through explicit recovery connections; leave unhandled errors available for manual recovery.
- Cancel manually without starting rollback steps.
- Restart the Session Host, retain progress, and require an explicit retry or schema-valid supplied output.
- Edit or delete a definition without changing an existing execution or its recovery copy.
- Restrict a workflow to a Project and its Worktrees, execute in the selected Scope, and block a Backend Adapter mismatch.
- Exercise Ask and Auto-accept independently from Enquiries; resolve named secrets without saving their values as inputs.
- Test one step without executing its successors or competing with an existing workflow execution.
- Reap an Agent Session and remove its workflow execution history.
