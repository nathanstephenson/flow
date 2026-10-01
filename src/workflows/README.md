# Workflow core

The Session Host owns execution through `src/daemon/workflow-executions.ts` and the frozen HTTP routes below. Definition and secret CRUD remain machine-wide. Private workflow requests are relayed by the parent model through the existing composer controls and correlated back to the owning attempt.

## Execution HTTP contract

`src/protocol/workflow-executions.ts` defines the shared contract for execution service and web integration. The following routes are the implementation target:

- `GET /api/sessions/:sessionId/workflows` returns `WorkflowExecutionList`.
- `POST /api/sessions/:sessionId/workflows` accepts `StartWorkflow` and returns `WorkflowExecutionView`.
- `GET /api/sessions/:sessionId/workflows/:executionId` returns `WorkflowExecutionView`.
- `POST /api/sessions/:sessionId/workflows/:executionId/cancel` returns `WorkflowExecutionView`.
- `POST /api/sessions/:sessionId/workflows/:executionId/recover` accepts `RecoverWorkflow` and returns `WorkflowExecutionView`.
- `POST /api/workflows/test` accepts `TestWorkflowStep` and returns `WorkflowExecutionView`. The submitted definition can be unsaved; only the selected step executes.
- `GET /api/workflow-runtime` returns `WorkflowRuntimeStatus` for local code steps, requiring host Node 22 or later and available filesystem enforcement. Agent steps inherit their Backend Session's boundary.

Mutations validate their bodies before execution. Occupied slots return 409. Other error responses follow the existing resource API. Human responses are accepted only through an active parent relay tool call; the public workflow routes do not expose direct answer endpoints. Model, Effort, instructions and schemas come from the execution's fixed definition. Missing Spend remains unknown, not zero.

## Definition and secret HTTP API

All routes require the normal bearer token or cookie and same-origin checks. PUT creates or replaces; DELETE is idempotent and returns `{ deleted: true }`.

- `GET /api/workflows` → `{ workflows: WorkflowDefinition[] }`.
- `GET /api/workflows/:id` → `{ workflow: WorkflowDefinition }`.
- `PUT /api/workflows/:id` accepts a `WorkflowDefinition`, with matching ID, and returns `{ workflow: WorkflowDefinition }`. Schema and graph validation run before storage. The body limit is 1,000,000 bytes.
- `DELETE /api/workflows/:id` deletes only the definition. Execution snapshots remain unchanged.
- `GET /api/secrets` → `{ names: string[] }`, sorted.
- `GET /api/secrets/:name` → `{ name: string }`, never the value.
- `PUT /api/secrets/:name` accepts `SecretWrite` (`{ value: string }`) and returns `SecretMetadata` (`{ name: string }`). Values must contain 1–64,000 UTF-8 bytes; JSON bodies are limited to 400,000 bytes.
- `DELETE /api/secrets/:name` removes the value.

Errors are `{ error: string }`: 400 invalid input, 401 unauthenticated, 403 disallowed Origin, 404 missing resource, 405 unsupported method, 413 oversized body, or 500 storage failure. Secret and definition errors never include submitted data. IDs use 1–128 ASCII letters, digits, underscores or hyphens. Secret names start with an ASCII letter or underscore, use the same alphabet, and reject `__proto__`, `constructor`, and `prototype`. Definition secret references use that same validator. Unresolved references may be saved; resolution belongs to execution.

`SecretStore(stateRoot)` owns `secrets/` (0700), separate from Settings. Each value is a 0600 file replaced atomically with file and directory sync. Public reads are `list(): string[]` and `has(name): boolean`; writes are `set(name, value)` and `delete(name)`. Only internal code uses `resolve(name, signal?): string`, which checks cancellation and throws a fixed error if unavailable. No HTTP route exposes this method.

`ConfigStore.view()` and `/api/config` report `workflowRuntime` with only an optional absolute `nodePath` override. PUT `/api/config` merges this field; an empty override clears it. `workflowRuntimeOptions` discovers an omitted Node executable on PATH, ignoring relative PATH entries. A missing executable remains undefined; execution integration must reject it rather than fall back. Settings file reads retain valid fields and discard invalid overrides with a warning. Filesystem enforcement is mandatory, not a runtime setting.

The CLI constructs one WorkflowStore, SecretStore and WorkflowExecutionService. `prestart` builds web assets and the source runtime; SEA installations use the extracted runtime asset. The service probes executors asynchronously, snapshots runtime Settings for each execution, and refreshes cached readiness when Settings change. Recovery uses the saved runtime Settings and definition. It owns cancellation, private activity, human requests and per-step Spend. See ADR 0023.

## Contracts

- `src/protocol/workflows.ts`: JSON definitions, schemas, graph connections, execution snapshots, and attempt records.
- `schema.ts`: `toZod`, `parseValue`, `toTypeScript`, schema paths, and standard Shell output. Object fields are optional unless required or defaulted. Generated unions describe converging inputs; recovery partial outputs have optional object fields.
- `graph.ts`: `validateDefinition` returns a validated copy, topological order, incoming/outgoing connections, and generated input/output schemas. Mappings use step IDs, not names. Conditional availability is checked across possible outcomes. A mapping cannot access a possibly absent step output; it can access a completed join with optional fields.
- `records.ts`: `parseExecution` validates saved records and their definition/attempt identities.
- `store.ts`: `WorkflowStore` stores machine-wide definitions in `workflows/` and execution history in `sessions/<id>/workflows/`. Writes replace snapshots atomically and sync files and directory entries. Reaping the Agent Session directory removes its history.
- `scheduler.ts`: `WorkflowScheduler`, `WorkflowExecutor`, `ExecutorContext`, and `WorkflowStepError`.

Create one scheduler per Session Host and state root. Its constructor reconciles unfinished records without executing work. Use `start`, `get`, `wait`, `occupied`, `cancel`, `interrupt`, and `recover`. `start` returns immediately; `wait` returns when independent work has stopped and the execution has completed or requires recovery. Storage failures reject `wait` and retain the slot. Before Reap, stop owned work with `cancel` or `interrupt`, then call `forgetSession(sessionId)` and delete the Agent Session directory. The hook rejects while work is running; otherwise it releases all in-memory records and the slot. It does not delete durable history.

`recover` accepts Retry, schema-valid Supply output, or explicit Continue when an interruption occurred between steps. Completed outputs are retained. Failed handling paths require manual recovery; their own failure connections do not launch another handling path. Recover the failed handling step, not the already handled original failure.

Use `start(..., testStepId)` for one-step tests. Sample input uses that step's input schema. No other step or handling connection executes. Failed tests retain the slot until recovery or cancellation.

## Executor requirements

`check` must synchronously reject unavailable capabilities, unsupported models/Effort, and unsupported permission modes. It runs before a start is saved. Definitions and steps carry only named secret references; secret resolution is a later integration.

`execute` receives explicit JSON input, Scope, effective permission mode, identifiers, the step configuration, and an AbortSignal. It must return only when its owned work has stopped, including Subagents, Background Calls, process trees, and outstanding runtime operations. It must stop on abort. Cancellation and timeout handling wait for that promise, so another execution or handling path cannot overlap unfinished work.

Shell and TypeScript timeouts default to 60 seconds. Agent timeouts are optional. TypeScript requires an injected executor. Its `check` owns runtime availability and mandatory Linux filesystem enforcement. Unavailable enforcement refuses execution; there is no isolation opt-out or unrestricted fallback.

A successful output is validated before it is saved. Shell output is `{ exitCode, stdout, stderr }`; accepted exit codes default to `[0]`. Throw `WorkflowStepError` to retain partial JSON output with a failure. Executors must not return resolved secrets as configuration. Code executors retain complete output and apply best-effort literal secret redaction. Agent permission/Enquiry routing, Spend and live Subagent activity remain separate integration work.

## Graph behaviour

Step IDs, step names, schema fields, mapping keys, and secret keys reject `__proto__`, `constructor`, and `prototype`. Declared input schemas must accept inferred inputs, with or without mappings.

Roots run in parallel. Connections select success, failure, timeout, or a boolean branch result. A consumer waits for incoming paths to resolve; skipped paths do not delay it. An unhandled failure blocks dependents but not independent paths. A join always collects selected inputs by source step name. Other steps receive one selected predecessor directly, or multiple selected predecessors by name, unless explicitly mapped.

Selected completed nodes with no selected outgoing connection provide the final result. One terminal returns directly; multiple terminals are keyed by name. No End node is used. Successful explicit or manual recovery retains original attempt errors and reports `completed-with-recovery`.

## Workflow Loops in the browser

Cycles automatically form nested groups. There is no loop creation action. Groups use topology analysis even when a mapping or schema needs repair. Max tries defaults to 3, accepts 1–100, and includes the first check. Inner limits reset on each outer try. Branch connections select exits; overlapping and multiple-entry cycles are rejected.

Step positions remain absolute in saved definitions. The browser derives parent-relative positions and converts them back on drag. Groups cannot be selected or deleted as steps. Removing a cycle removes its settings and header repeat mapping. Headers have separate First entry and Repeat mapping controls.

Execution groups show fixed limits and current tries, including extra grants for the current activation. At a limit, the parent diagnoses recovery in chat and asks for confirmation before granting an extra try. The execution panel retains diagnostics and Cancel, not manual recovery forms. Optional guidance is added to Agent instructions only for that extra try and does not change the saved definition. Recovery submits the current header, activation and try identity. Step attempts show their enclosing loop identities; normal loop work is not a manual retry.

## Shell and TypeScript executors

`createCodeExecutors` in `executors.ts` supplies the scheduler's `shell` and `typescript` contracts. Configure an absolute `runtimePath` and an absolute host Node 22-or-later `nodePath` (not the Flow SEA executable). Inject `resolveSecret(reference, signal)` when named secrets are used. Resolution must obey cancellation. The scheduler supplies generated `inputSchema`; direct callers must supply it or TypeScript input is `unknown`. `check` rejects missing files, missing secret resolution, unsupported platforms and unavailable enforcement before execution is saved. No host or Settings dependency is required. Await `createCodeExecutors(options)` during runtime setup; it returns `Promise<Executors>`. The Node readiness probe runs asynchronously behind the filesystem boundary with a five-second limit. The factory caches readiness, so synchronous `check` calls and setup do not block another Agent Session's execution heartbeats. Recreate it when runtime Settings change. Loss of the runtime or enforcement after that check fails execution without fallback.

Local execution requires Linux and Bubblewrap with descriptor-backed bind mounts and working user, mount and PID namespaces. Host-owned descriptors pin Scope and runtime mount sources before launch. One boundary covers the trusted local supervisor, TypeScript compiler/QuickJS worker and every Shell descendant. Host files are read-only or masked, with only Scope and private execution state writable; host credentials, Flow state and control sockets remain hidden. Readiness probes use the same policy. See ADR 0028.

TypeScript code is a function body, for example:

```ts
await fs.mkdir('artifacts');
await fs.writeText('artifacts/result.json', JSON.stringify(input));
return (await fetch('http://localhost:8080/result')).body;
```

The closed compiler reads only embedded TypeScript standard declarations and generated input/output/API declarations. It exposes no DOM or Node declarations and rejects imports, including dynamic imports and import types. Guest JavaScript executes only in QuickJS WASM, with no module loader or process APIs. `Function` remains a guest-language function; it cannot access Node. The guest receives JSON `input`, selected string properties on `secrets`, async `fs.readText`, `fs.writeText`, `fs.mkdir`, and `fetch`. Fetch accepts a URL and optional method, string headers and string body, returning `status`, `ok`, string `body`, and async `text()`/`json()` readers. This is a small fetch subset, not a DOM Response. It supports unrestricted HTTP(S), including local addresses, at most five redirects. Cross-origin redirects discard supplied headers. Operations are not transactions.

Shell uses `/bin/bash --noprofile --norc -c` in Scope. Input is JSON in the `OUTPUT` shell variable, transported via stdin rather than an environment entry so large inputs do not hit OS argument limits. Use `printf '%s' "$OUTPUT" | command` to pass it to child processes; it is not exported. Only fixed PATH/LANG and selected secret environment variables are supplied. Unsafe environment variable names are rejected. Results keep stdout, stderr and exitCode separate. The scheduler checks accepted exit codes. Complete stdout and stderr are retained; output size alone does not fail the step.

Limits: 100,000 code characters, 1,000 guest API calls, 32 concurrent calls, 32 MiB QuickJS memory and 512 KiB guest stack. QuickJS interrupts at the configured step deadline; time waiting for IO does not consume a separate CPU allowance. Trusted Node workers have a 128 MiB heap limit. Owned local processes also start with core dumps disabled. These fixed limits are not a general OS memory, CPU or process-count quota for Shell descendants.

Cancellation closes input to the trusted supervisor. It aborts fetch and waits for owned work; a guest worker that cannot stop is killed after 500 ms. Shell process groups are killed and their output pipes drained, including on normal shell exit. The host sends a heartbeat every 500 ms; the supervisor stops work after three seconds without one, or immediately on EOF. A separate local supervisor keeps this lease active while TypeScript checking or guest code blocks. The host force-kills the boundary after five seconds if cancellation cannot finish. Its inherited PID namespace bounds all descendants, including processes that detach or create a new session; boundary teardown removes them rather than leaving escaped host processes.

### Build and packaging

Run `npm run build:workflow-runtime` and use the absolute `build/workflow-runtime.cjs` path for source installations. The bundle contains the trusted runner, compiler declarations and QuickJS WASM; it needs host Node 22 or later and Linux Bubblewrap enforcement, not node_modules or source files. `scripts/build-binary.mjs` embeds the same bundle as the SEA asset `workflow-runtime.cjs`. `embeddedWorkflowRuntime()` extracts that read-only asset into a private temporary directory. Host integration must pass that path to the factory. A binary also requires host Node 22 or later and available enforcement. The factory checks these prerequisites. Missing runtime files cause an explicit error, never a source-relative fallback. Extracted files contain runtime code only, never inputs or secrets.

Linux Node 22.16.0 is the verified SEA toolchain; use Node 22 for binary builds. Core and adapter TypeScript tests run directly with Node 22 using `--experimental-strip-types`. The TypeScript configuration requires erasable syntax.

### Isolation limits

The mandatory OS boundary complements the QuickJS guest and scoped filesystem APIs; it is not a complete untrusted-code sandbox. Shell can read host files not deliberately hidden, but cannot widen its writable mounts through symlinks. Network remains unrestricted, including access to local services that may expose host data or control APIs. Read-only host files are not a confidentiality guarantee.

TypeScript filesystem access rejects absolute paths and paths escaping Scope. Each directory is opened with `O_DIRECTORY | O_NOFOLLOW`; child access uses that open descriptor, and final file opens also use `O_NOFOLLOW`. Intermediate symlink swaps therefore cannot redirect file opens. Linux uses `/proc/self/fd`. These checks do not make a mutable directory tree atomic: an already opened directory can be renamed, and the parent can change Scope contents concurrently. Pinned mount sources preserve the launched boundary's identity, not a file-conflict lock or snapshot. Hard links and other pre-existing data aliases can share an inode with a location outside Scope; the OS boundary cannot undo that sharing. Do not use a Scope containing aliases to protected files.

Detached descendants remain inside the inherited PID namespace and are removed on boundary teardown, including cancellation and host loss. Do not interpret cleanup as rollback. Secrets exist only in in-memory messages and selected guest properties/Shell environment. Literal output redaction is best-effort; guest code can encode or transmit them. Runtime errors and Node fatal diagnostics are not a complete information-flow filter.

## Inspection and recovery

The parent receives compact current-workflow context on every user turn and a deduplicated recovery notification when idle (queued while busy). `workflow_inspect` resolves the associated execution without an ID; `summary` supplies a state revision, `execution` includes inputs/outputs, and `activity` pages the durable redacted transcript by step and attempt. Full transcripts are never automatically injected.

`workflow_recover` rejects stale state. One provably safe retry/continue per failure episode is allowed automatically; completed executed attempts reset the budget, not a retry launch or supplied output. Agent, shell and MCP retries have uncertain external effects and require a one-shot human confirmation, as do replacement outputs and loop extensions. Confirmations are bound to the revision and cancelled with the parent or workflow. Existing scheduler validation and tool permissions still apply.

New activity is fsynced to `workflow-activity/<execution>.jsonl`; the JSON sidecar contains a recent preview and recovery bookkeeping. Legacy runs retain their surviving events with an explicit unavailable-history indicator. All attempts remain inspectable after restart. Output and transcript transport have no arbitrary 100k/1MB rejection; timeout, runtime memory, code-size, loop and schema limits still apply.
