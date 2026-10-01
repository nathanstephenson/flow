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
Only explicitly validated runtime assets and the selected Scope are restored beneath those masks.
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

Local Workflow Shell and TypeScript execution also receives this policy when the external Docker
runtime is disabled. Local Node readiness probes run behind the policy too. Local stdio MCP servers
receive the filesystem policy, since executing them outside it would turn host-side tool delegation
into a bypass. Explicit dependency asset mounts keep Node stdio packages available under ancestor masks.

External Docker Workflow execution is currently unavailable and fails closed before even its
readiness probe. A validated mount pathname is not a pinned inode: a concurrent model with an
ancestor Scope could redirect Docker's writable mount. Passing a host-owned `/proc/<pid>/fd/<fd>`
source may work on some daemon/OCI runtime stacks, but their string-based mount APIs do not guarantee
that identity end to end. Flow has not verified an installed stack. Neither before/after path checks
nor an unrestricted/local fallback are acceptable. Re-enabling this mode requires verified source
pinning for Scope and runtime assets through container removal. A future host supervisor must still
run already-loaded trusted code, never a Workflow bundle a writable Scope could replace.

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
