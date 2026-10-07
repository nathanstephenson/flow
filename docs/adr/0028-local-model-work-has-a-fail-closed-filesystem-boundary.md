# 28. Local filesystem isolation is optional; enabled mode fails closed

## Status

Accepted, amended to replace mandatory enforcement with a machine-wide optional policy. The
filename is retained for stable links; fail-closed behaviour applies whenever isolation is enabled.

## Decision

Filesystem isolation is toggled in **Settings → General → Filesystem isolation**, not per Scope,
model, Workflow Step or MCP Connection. The optional persisted key is
`filesystemIsolation?: boolean`: `true` requires enforcement, `false` selects unrestricted
execution, and omission selects automatic mode. PUT `/api/config` accepts `null` to remove the
override and return to automatic; omission in a patch leaves the override unchanged.

Automatic mode uses an actual launch capability check, not merely Linux detection or finding a
Bubblewrap executable. It defaults ON when Linux Bubblewrap enforcement with descriptor-backed
mounts and working user, mount and PID namespaces is available. Unsupported operating systems,
missing Bubblewrap and unavailable namespaces default to **UNRESTRICTED** with a clear warning,
not refusal to run Flow. macOS can run Flow without this Linux-only enforcement. The initial
capability-dependent automatic choice is latched for the Session Host's lifetime; fixing support
requires a host restart to refresh that choice. While checking, automatic work waits for the result.

The config view reports `supported`, `enabled`, `automatic`, `checking` and `reason`. General
Settings displays the support reason and an explicit warning about unrestricted filesystem
authority when isolation is off. Explicit enable fails closed: unsupported enforcement or a failed
restricted launch refuses work. An enabled policy never silently downgrades after a launch failure,
and there is no model-controlled opt-out.

Policy changes apply to new Backend Sessions (including Revive), new Workflow Executions and new
local stdio MCP clients. Existing work retains its captured policy; recovery retains the Workflow
Execution's saved policy. Agent Workflow Steps inherit their owning Backend Session's boundary.
HTTP MCP and network access remain unchanged. Local Workflow execution stays local; this amendment
does not restore Docker execution.

Production Claude and Pi Backend Sessions run behind the worker IPC boundary (ADR 0027) in **both**
modes. Disabling filesystem isolation does not disable worker process separation, ownership,
heartbeats or cancellation. Those mechanisms alone are not an OS-enforced filesystem or detached
process boundary.

Claude's project records use the same dedicated backend `claude-projects` directory in both
modes, so changing the policy on Revive does not change their storage location. Unrestricted
Claude uses an ephemeral config view but retains its normal shared credential store and refresh
locks through `CLAUDE_SECURESTORAGE_CONFIG_DIR`, including normal CLI/concurrent-session sharing.
Restricted Claude reuses its narrowly staged view and never receives a host auth-root override.
Credentials are not persisted in the durable project-record directory. On Revive, legacy resume IDs
whose records exist only in the global Claude projects directory are migrated by the host before
worker launch. Only the saved UUID's transcript and UUID-owned sidecars under the selected Scope
are copied; linked records are refused. Existing owned conversations remain authoritative. Flow
never bulk imports other Agent Sessions' records or exposes the global projects tree to workers.

Local stdio MCP transports own ordinary subprocess groups in both modes. Shutdown is bounded and
drains already-written stdout with a bounded EOF wait before closing inherited pipes, so a final
MCP reply is not discarded on leader exit and a surviving pipe holder cannot hang Retry or disposal.
Restricted mount state remains until actual leader exit and group cleanup. These
lifecycle controls are not unrestricted-mode confinement: detached descendants can escape them.

### Enabled-mode enforcement

On Linux, Flow launches workers through Bubblewrap. The host filesystem is read-only, the canonical
Scope is writable, and adapter state and scratch space have distinct private writable mounts.
Ordinary Subagents, Background Calls and adapter-owned Workflow Subagents inherit that boundary.
A separate container or virtual machine per Subagent is unnecessary.

The Session Host's state, including transcripts, tokens, Workflow Definitions, execution history
and secrets, is not writable or directly exposed to workers. Only the selected backend's state
is mounted at a worker-private path for Revive. Credential files needed by the selected SDK are
staged narrowly into a private home, never by mounting the real home writable. Known host SSH,
cloud and package credential stores are masked too. SDK resource folders are mounted read-only,
without admitting symlinks or parents that contain protected host state. Adapter-local credential
refresh does not write back to the user's global credential files. A separately configured Claude
auth root is masked too and only its credential file is staged. Nonempty `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` must be absolute for restricted launches: relative roots use the
CLI's Scope, and literal `~` is not expanded, so host-cwd resolution could select the wrong store.
Missing protected paths are
masked through an existing ancestor so credentials or host state created later remain hidden.
Only validated runtime assets and the selected Scope are restored beneath those masks. PATH-selected
tool directories and their linked package/library assets are discovered narrowly and mounted
read-only, so home-installed npm/npx do not silently switch to system versions. Masked directory
aliases in PATH are rewritten to their canonical tool directories. Intentionally protected PATH
entries remain hidden; discovery never restores a credential store or a broad home ancestor.
Enforcement executables and unrestricted launch runtimes must remain outside writable backend state.

Scope bindings are recorded canonically and later symlink redirection refuses execution. Mount
sources are pinned with host-owned descriptors before launch; Bubblewrap consumes them before
executing worker code. The private process filesystem is read-only too. Temporary credential staging uses the system temporary directory, never an
operator TMPDIR that could fall inside writable Scope. The stdio MCP supervisor is already-loaded
code, not a mutable Project script, and it passes those descriptors where the MCP SDK cannot.

A new PID namespace prevents access to the Session Host through `/proc` and bounds descendant
lifetime. A minimal device filesystem and private runtime/temporary directories avoid exposing
host control sockets such as Docker's. Workers have no added capabilities or privilege escalation.
Network access remains available for inference.

When isolation is enabled, local Workflow Shell and TypeScript execution receives this policy.
One boundary covers the local supervisor, TypeScript compiler/QuickJS worker and all Shell
descendants. The inherited PID namespace enforces cleanup even when descendants detach or create
new sessions. Host Node 22 or later is required in both modes; enabled mode also requires available
enforcement. Node readiness probes use the captured policy too. `workflowRuntime` Settings contain
only an optional absolute `nodePath` override; isolation is the separate machine-wide setting.
Local stdio MCP servers also receive the captured policy, since executing them outside an enabled
boundary would turn host-side tool delegation into a bypass. Explicit dependency asset mounts keep Node
stdio packages and npm/SEA workers available under ancestor masks, including ancestor node_modules
search paths and linked packages
outside the launch package. These trees pass the same protected-state checks and descriptor pinning;
dependency discovery never grants general access to the containing home or workspace. A masked
node_modules lookup alias is recreated as a namespace symlink to its validated, pinned target, not
as a second directory bind that would change Node's realpath-based lookup. Missing parent lookup aliases (such as $PREFIX/lib) are preserved too, without mounting their
containing directories or sibling data. Recreated alias destinations canonicalize their parents;
both destinations and targets pass the same protected-state checks, so parent aliases cannot
graft execution assets into hidden host state. SEA SDK discovery also preserves Node's default
$PREFIX/lib/node lookup; this is distinct from the scrubbed NODE_PATH environment override.

With isolation enabled, a missing Bubblewrap executable, unavailable namespaces, invalid Scope or
failed restricted launch refuses work. This remains fail closed even if the initial support check
succeeded; it never launches unrestricted as recovery. Fake adapters and direct SDK integration
tests are not production registration.

### Unrestricted mode

Scope is only a working directory, not a writable boundary. Agent tools, Shell commands and local
stdio MCP servers have the host user's filesystem authority: they can read, write and delete
outside Scope, including credentials and Session Host state that enabled mode masks. Worker
separation and process-group cleanup remain, but there is no inherited PID namespace to contain
detached processes; descendants that detach can escape that cleanup.

Closed TypeScript compilation, the QuickJS guest and the scoped filesystem API remain in place
when isolation is off. They reject imports, process APIs, escaping paths and symlink traversal for
direct TypeScript API access. They do not restrict Shell's or the trusted Node supervisor's host
authority through an OS boundary. TypeScript guest restrictions must not be presented as equivalent
to enabled Linux filesystem enforcement.

## Consequences and limits

Enabled isolation is a local filesystem and process boundary, not a complete untrusted-code
sandbox. Models and remote MCP tools can still use authorised external services, including services
reachable through network connections. Read-only host files are not a confidentiality guarantee. Operator-supplied
credentials and secrets remain available to the work for which they were supplied. A malicious
Scope or pre-existing hard link can share an inode with another location; read-only mount paths do
not undo that sharing. Do not use a Scope containing hard links to protected files.

The Scope itself can still be deleted or corrupted. This policy complements, rather than replaces,
Git and backups. It does not restrict explicit human Shells or host-owned Git operations. Git
Worktree metadata outside Scope is not granted general write access in enabled mode; agent Git
commands that need it can fail, while host-owned Git operations remain available.

With isolation enabled, a project can read files outside Scope where they are not deliberately
hidden, but cannot modify them through normal filesystem operations. Symlinks cannot widen its
writable mounts. With isolation disabled, none of these OS-enforced write or masking guarantees
apply. Changes to SDK state locations, launch paths, MCP transports or Workflow runtimes must
preserve enabled-mode guarantees and be tested through real restricted processes, not merely
argument inspection. Tests must also cover the unrestricted warning, latched automatic choice,
policy capture by new work, and refusal without downgrade after an enabled launch failure.
