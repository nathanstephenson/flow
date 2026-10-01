# 28. Local model work has a fail-closed filesystem boundary

## Status

Accepted.

## Decision

Production Claude and Pi Backend Sessions run behind the worker IPC boundary (ADR 0027). On Linux,
Flow launches their workers through Bubblewrap. The host filesystem is read-only, the canonical
Scope is writable, and adapter state and scratch space have distinct private writable mounts.
Ordinary Subagents, Background Calls and adapter-owned Workflow Subagents inherit that boundary.
A separate container or virtual machine per Subagent is unnecessary.

The Session Host's state, including transcripts, tokens, Workflow Definitions, execution history
and secrets, is not writable or directly exposed to workers. Only the selected backend's state
is mounted at a worker-private path for Revive. Credential files needed by the selected SDK are
staged narrowly into a private home, never by mounting the real home writable. Known host SSH,
cloud and package credential stores are masked too. SDK resource folders are mounted read-only,
without admitting symlinks or parents that contain protected host state. Adapter-local credential
refresh does not write back to the user's global credential files. Missing protected paths are
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

Local Workflow Shell and TypeScript execution always receives this policy. One boundary covers
the local supervisor, TypeScript compiler/QuickJS worker and all Shell descendants. The inherited
PID namespace enforces cleanup even when descendants detach or create new sessions. Host Node 22
or later and available enforcement are required; Node readiness probes run behind the policy too.
`workflowRuntime` Settings contain only an optional absolute `nodePath` override, not an isolation
opt-out. Local stdio MCP servers receive the filesystem policy, since executing them outside it
would turn host-side tool delegation into a bypass. Explicit dependency asset mounts keep Node
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

A missing Bubblewrap executable, unavailable namespaces, invalid Scope or failed restricted launch
refuses work. There is no silent unrestricted fallback or model-controlled opt-out. Unsupported
operating systems cannot execute production model work until an equivalent enforcement mechanism
is implemented. Fake adapters and direct SDK integration tests are not production registration.

## Consequences and limits

This is a local filesystem and process boundary, not a complete untrusted-code sandbox. Models and
remote MCP tools can still use authorised external services, including services reachable through
network connections. Read-only host files are not a confidentiality guarantee. Operator-supplied
credentials and secrets remain available to the work for which they were supplied. A malicious
Scope or pre-existing hard link can share an inode with another location; read-only mount paths do
not undo that sharing. Do not use a Scope containing hard links to protected files.

The Scope itself can still be deleted or corrupted. This policy complements, rather than replaces,
Git and backups. It does not restrict explicit human Shells or host-owned Git operations. Git
Worktree metadata outside the Scope is not granted general write access; agent Git commands that
need it can fail, while host-owned Git operations remain available.

A project can read files outside its Scope where they are not deliberately hidden, but cannot
modify them through normal filesystem operations. Symlinks cannot widen its writable mounts.
Changes to SDK state locations, launch paths, MCP transports or Workflow runtimes must preserve
this guarantee and be tested through real restricted processes, not merely argument inspection.
